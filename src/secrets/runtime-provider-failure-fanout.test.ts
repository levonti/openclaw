import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.js";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const EXEC_FIXTURE_TIMEOUT_MS = 20_000;
let root: string;
beforeEach(() => {
  root = tempDirs.make("openclaw-provider-failure-");
});
const execRef = (provider: string, id: string) => ({ source: "exec" as const, provider, id });
const providerFailures = (...providers: string[]) =>
  providers.map((provider) => ({ source: "exec", provider }));
function failedOwner(ownerKind: string, ownerId: string, ...providers: string[]) {
  return {
    ownerKind,
    ownerId,
    reason: "secret provider failed",
    providerFailures: providerFailures(...providers),
  };
}

async function writeProvider(name = "provider", body = "exit 1\n") {
  const command = path.join(root, name + ".sh");
  await fs.writeFile(command, "#!/bin/sh\n" + body, { encoding: "utf8", mode: 0o700 });
  return {
    source: "exec" as const,
    command,
    passEnv: ["PATH"],
    timeoutMs: EXEC_FIXTURE_TIMEOUT_MS,
    noOutputTimeoutMs: EXEC_FIXTURE_TIMEOUT_MS,
  };
}

function prepareFailure(
  providers: Record<string, Awaited<ReturnType<typeof writeProvider>>>,
  config: Record<string, unknown>,
) {
  return prepareSecretsRuntimeSnapshot({
    config: asConfig({ ...config, secrets: { providers } }),
    env: { PATH: process.env.PATH ?? "" },
    includeAuthStoreRefs: false,
    allowUnavailableSecretOwners: true,
    loadablePluginOrigins: new Map(),
  });
}

function modelConfig(
  apiKey: unknown,
  headers?: Record<string, unknown>,
  provider = "example",
  baseUrl?: string,
) {
  return { models: { providers: { [provider]: { apiKey, headers, models: [], baseUrl } } } };
}

describe("provider-scoped SecretRef failure fan-out", () => {
  it("preserves provider provenance for an unavailable web-search owner", async () => {
    if (process.platform === "win32") {
      return;
    }
    const vault = await writeProvider();
    const ref = execRef("vault", "web/gemini");

    const snapshot = await prepareFailure(
      { vault },
      {
        tools: { web: { search: { provider: "gemini" } } },
        plugins: { entries: { google: { config: { webSearch: { apiKey: ref } } } } },
      },
    );

    expect(snapshot.degradedOwners).toContainEqual(
      expect.objectContaining(failedOwner("capability", "web-search:gemini", "vault")),
    );
  });

  it("reuses one provider failure across isolated owners", async () => {
    if (process.platform === "win32") {
      return;
    }
    const callLogPath = path.join(root, "calls.log");
    const shared = await writeProvider(
      "provider",
      `printf 'call\\n' >> ${JSON.stringify(callLogPath)}\nexit 1\n`,
    );
    const modelRef = execRef("shared", "models/openai");
    const ttsRef = execRef("shared", "tts/elevenlabs");

    const snapshot = await prepareFailure(
      { shared },
      {
        ...modelConfig(modelRef, undefined, "openai", "https://api.openai.com/v1"),
        tts: { providers: { elevenlabs: { apiKey: ttsRef } } },
      },
    );

    expect(snapshot.config.models?.providers?.openai?.apiKey).toEqual(modelRef);
    expect(snapshot.config.tts?.providers?.elevenlabs?.apiKey).toEqual(ttsRef);
    expect(snapshot.degradedOwners).toMatchObject([
      failedOwner("provider", "openai", "shared"),
      failedOwner("capability", "tts", "shared"),
    ]);
    expect((await fs.readFile(callLogPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("records every failed provider used by one isolated owner", async () => {
    if (process.platform === "win32") {
      return;
    }
    const first = await writeProvider("first");
    const second = await writeProvider("second");

    const snapshot = await prepareFailure(
      { first, second },
      modelConfig(execRef("first", "api-key"), { "X-Secondary": execRef("second", "secondary") }),
    );

    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "provider",
        ownerId: "example",
        providerFailures: providerFailures("first", "second"),
      },
    ]);
  });

  it("retains a ref failure when the same owner also has a provider outage", async () => {
    if (process.platform === "win32") {
      return;
    }
    const unavailable = await writeProvider();
    const refResponse = JSON.stringify({
      protocolVersion: 1,
      values: {},
      errors: { secondary: { code: "NOT_FOUND" } },
    });
    const partial = await writeProvider("ref", `printf '%s\\n' ${JSON.stringify(refResponse)}\n`);

    const snapshot = await prepareFailure(
      { unavailable, partial },
      modelConfig(execRef("unavailable", "api-key"), {
        "X-Secondary": execRef("partial", "secondary"),
      }),
    );

    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "provider",
        ownerId: "example",
        reason: "secret reference was not found",
        providerFailures: providerFailures("unavailable"),
        refFailureReason: "secret reference was not found",
      },
    ]);
  });
});
