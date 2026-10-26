import http, { createServer, type ClientRequest, type RequestOptions } from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { createNodeProxyAgent } from "openclaw/plugin-sdk/fetch-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../test-support/hanging-loopback-server.js";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import { createAudioPeer } from "./realtime-quicksilver-gateway.test-support.js";
import { createOpenAIQuicksilverBrowserSessionBroker } from "./realtime-quicksilver-session.js";
import {
  createCallResponse,
  postOffer,
  reserveLiveSession,
} from "./realtime-quicksilver.test-helpers.js";

const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  try {
    for (const close of closers.splice(0).toReversed()) {
      await close();
    }
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

// These sidebands need the Gateway-isolate proxy hooks, unlike a bare `ws` import.
// Real hooks: src/infra/net/proxy/managed-proxy-openai-realtime.test.ts.
describe("OpenAI realtime sidebands under the managed proxy", () => {
  it.each(["browser", "gateway"])(
    "offers the %s sideband only to the managed proxy",
    async (kind) => {
      const proxy = await startRefusingProxy();
      routeNodeHttpThroughProxy(proxy.url);
      if (kind === "browser") {
        const realtime = createOpenAIQuicksilverBrowserSessionBroker(
          {
            getConfig: () => ({}),
            logger: { debug: vi.fn(), warn: vi.fn() },
            fetchImpl: vi.fn(async () => createCallResponse()),
          },
          openAIRealtimeHost,
        );
        closers.push(() => realtime.cleanup());
        const reservation = await reserveLiveSession(realtime);
        const response = await postOffer(realtime, { token: reservation.clientSecret });

        expect(response.res.statusCode).toBe(502);
      } else {
        const bridge = new OpenAIQuicksilverGatewayBridge(
          {
            providerConfig: {},
            model: "gpt-live-test-canary",
            audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
            onAudio: vi.fn(),
            onClearAudio: vi.fn(),
            logger: { debug: vi.fn(), warn: vi.fn() },
            runAgentConsult: vi.fn(async () => ({ text: "done" })),
            resolveAuth: async () => ({
              type: "oauth",
              token: "oauth-token",
              accountId: "account-1",
            }),
            createPeer: async () => createAudioPeer(),
            fetchImpl: vi.fn<typeof fetch>(async () =>
              createCallResponse("v=answer\r\n", "rtc_bridge"),
            ),
          },
          openAIRealtimeHost,
        );
        closers.push(() => bridge.close());

        await expect(bridge.connect()).rejects.toThrow();
      }
      expect(proxy.connects.length).toBeGreaterThan(0);
      expect(new Set(proxy.connects)).toEqual(new Set(["api.openai.com:443"]));
    },
    15_000,
  );
});

// Mirrors the managed proxy's Gateway-isolate hooks: every node:http(s) request
// gets a proxy agent, and the caller's direct createConnection is dropped.
function routeNodeHttpThroughProxy(proxyUrl: string): void {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", undefined);
  for (const [module, protocol] of [
    [http, "http"],
    [https, "https"],
  ] as const) {
    const request = module.request;
    vi.spyOn(module, "request").mockImplementation(((
      options: RequestOptions,
      callback?: (response: http.IncomingMessage) => void,
    ): ClientRequest => {
      const agent = createNodeProxyAgent({ mode: "explicit", proxyUrl, protocol });
      const { createConnection: _direct, ...routed } = options;
      const routedRequest = request({ ...routed, agent }, callback);
      routedRequest.once("close", () => agent.destroy());
      return routedRequest;
    }) as typeof module.request);
  }
}

// Refuses every tunnel, so a sideband can only fail; the CONNECT targets show where it dialed.
async function startRefusingProxy() {
  const connects: string[] = [];
  const server = createServer((_request, response) => response.writeHead(405).end());
  server.on("connect", (request, client: Socket) => {
    connects.push(request.url ?? "");
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  const port = await listenOnLoopback(server);
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { connects, url: `http://127.0.0.1:${port}` };
}
