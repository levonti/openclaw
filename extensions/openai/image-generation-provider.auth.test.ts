import {
  isProviderApiKeyConfiguredAsync,
  listProfilesForProvider,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import {
  createCodexOAuthAuthStore,
  openAIImageConfig,
} from "./image-generation-provider.test-support.js";

let authStore: AuthProfileStore = { version: 1, profiles: {} };
let authConfigured = false;
const ensureAuthProfileStoreAsyncMock = vi.fn(async () => authStore);
const isProviderApiKeyConfiguredAsyncMock = vi.fn<typeof isProviderApiKeyConfiguredAsync>(
  async () => authConfigured,
);
const provider = buildOpenAIImageGenerationProvider({
  ensureAuthProfileStoreAsync: ensureAuthProfileStoreAsyncMock,
  listProfilesForProvider,
  isProviderApiKeyConfiguredAsync: isProviderApiKeyConfiguredAsyncMock,
});

async function expectConfigured(
  expected: boolean,
  config?: Parameters<typeof openAIImageConfig>[0],
) {
  expect(
    await provider.isConfiguredAsync?.({
      agentDir: "/tmp/agent",
      cfg: config && openAIImageConfig(config),
    }),
  ).toBe(expected);
}

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "");
  authStore = { version: 1, profiles: {} };
  authConfigured = false;
  ensureAuthProfileStoreAsyncMock.mockImplementation(async () => authStore);
  isProviderApiKeyConfiguredAsyncMock.mockImplementation(async () => authConfigured);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("OpenAI image generation auth availability", () => {
  it("uses capability-aware credential availability before checking the image route", async () => {
    authConfigured = true;
    await expectConfigured(true);
    expect(isProviderApiKeyConfiguredAsyncMock).toHaveBeenCalledWith({
      provider: "openai",
      agentDir: "/tmp/agent",
      cfg: undefined,
      store: undefined,
      capability: "image-generation",
    });

    authConfigured = false;
    await expectConfigured(false);
  });

  it("reports configured from a config apiKey (gateway-routed openai) with no env/profile creds", async () => {
    isProviderApiKeyConfiguredAsyncMock.mockImplementation(isProviderApiKeyConfiguredAsync);

    await expectConfigured(true, {
      baseUrl: "https://gateway.example.test/openai/v1",
      apiKey: "gateway-token",
    });
    expect(ensureAuthProfileStoreAsyncMock).not.toHaveBeenCalled();
  });

  it("honors canonical auth rejection even when another Codex profile exists", async () => {
    authStore = createCodexOAuthAuthStore();
    await expectConfigured(false);
  });

  it("treats a whitespace-only config apiKey as not configured", async () => {
    await expectConfigured(false, {
      baseUrl: "https://gateway.example.test/openai/v1",
      apiKey: "   ",
    });
  });

  it("reports ChatGPT OAuth image auth as configured for ChatGPT routes", async () => {
    authConfigured = true;
    authStore = createCodexOAuthAuthStore();

    await expectConfigured(true, {
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });

    expect(ensureAuthProfileStoreAsyncMock).toHaveBeenCalledTimes(1);
    expect(isProviderApiKeyConfiguredAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({ store: authStore }),
    );

    await expectConfigured(true, {
      api: "openai-chatgpt-responses",
      baseUrl: "https://openai-compatible.example.test/v1",
    });
  });

  it.each(["https://openai-compatible.example.test/v1", "https://api.openai.com/v1?proxy=1"])(
    "does not report OAuth auth as configured for %s",
    async (baseUrl) => {
      authConfigured = true;
      authStore = createCodexOAuthAuthStore();
      await expectConfigured(false, { baseUrl });
    },
  );
});
