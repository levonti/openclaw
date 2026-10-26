/** Tests inline secret refs discovered from runtime auth stores. */
import { describe, expect, it } from "vitest";
import { resolveAuthProfileSecretOwnerId } from "./runtime-auth-profile-owner.js";
import { activateSecretsRuntimeSnapshot } from "./runtime.js";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const EMPTY_LOADABLE_PLUGIN_ORIGINS = new Map();
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });
const defaultAgentDir = "/tmp/openclaw-agent-main";
function prepareProfiles(
  profiles: Parameters<typeof loadAuthStoreWithProfiles>[0],
  options: Partial<Parameters<typeof prepareSecretsRuntimeSnapshot>[0]> = {},
) {
  return prepareSecretsRuntimeSnapshot({
    config: asConfig({ models: {}, secrets: {} }),
    env: {},
    agentDirs: [defaultAgentDir],
    allowUnavailableSecretOwners: true,
    loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    loadAuthStore: () => loadAuthStoreWithProfiles(profiles),
    ...options,
  });
}
async function expectInlineRef(field: "key" | "token") {
  const ref = envRef(field === "key" ? "MY_KEY" : "MY_TOKEN");
  const value = `resolved-${field}-value`;
  const profileId = `custom:inline-${field}`;
  const profile =
    field === "key"
      ? { type: "api_key" as const, provider: "custom", key: ref as unknown as string }
      : { type: "token" as const, provider: "custom", token: ref as unknown as string };
  const snapshot = await prepareProfiles(
    { [profileId]: profile },
    {
      env: { [ref.id]: value },
      allowUnavailableSecretOwners: false,
    },
  );
  const resolved = snapshot.authStores[0]?.store.profiles[profileId] as Record<string, unknown>;
  expect(resolved[`${field}Ref`]).toEqual(ref);
  activateSecretsRuntimeSnapshot(snapshot);
  expect(resolved[field]).toBe(value);
}
function expectWarning(
  warnings: unknown,
  code: string,
  profileId: string,
  field = "key",
  dir = defaultAgentDir,
) {
  expect(warnings).toContainEqual(
    expect.objectContaining({ code, path: `${dir}.auth-profiles.${profileId}.${field}` }),
  );
}
function expectRefOnly(profile: unknown, provider: string, ref: unknown, field = "key") {
  expect(profile).toMatchObject({
    type: field === "key" ? "api_key" : "token",
    provider,
    [`${field}Ref`]: ref,
  });
  expect(profile).not.toHaveProperty(field);
}
const keyProfile = (provider: string, id: string) => ({
  type: "api_key" as const,
  provider,
  keyRef: envRef(id),
});

describe("secrets runtime snapshot inline auth-store refs", () => {
  it.each(["token", "key"] as const)("normalizes inline SecretRef objects on %s", expectInlineRef);

  it("skips refs on auth profiles that are not eligible for their configured provider", async () => {
    const profileId = "openai:mismatched";
    const tokenProfileId = "github-copilot:mismatched";
    const snapshot = await prepareProfiles(
      {
        [profileId]: { ...keyProfile("openai", "MISSING_MISMATCHED_KEY"), key: "unused" },
        [tokenProfileId]: {
          type: "token",
          provider: "github-copilot",
          token: "unused",
          tokenRef: envRef("MISSING_MISMATCHED_TOKEN"),
        },
      },
      {
        config: asConfig({
          auth: {
            profiles: {
              [profileId]: { provider: "anthropic", mode: "api_key" },
              [tokenProfileId]: { provider: "anthropic", mode: "token" },
            },
          },
        }),
      },
    );

    expect(snapshot.degradedOwners).toEqual([]);
    const code = "SECRETS_REF_IGNORED_INACTIVE_SURFACE";
    expectWarning(snapshot.warnings, code, profileId);
    expectWarning(snapshot.warnings, code, tokenProfileId, "token");
    const profiles = snapshot.authStores[0]?.store.profiles;
    expectRefOnly(profiles?.[profileId], "openai", envRef("MISSING_MISMATCHED_KEY"));
    expectRefOnly(
      profiles?.[tokenProfileId],
      "github-copilot",
      envRef("MISSING_MISMATCHED_TOKEN"),
      "token",
    );
  });

  it.each(["missing value", "unconfigured provider"])(
    "isolates a profile with %s",
    async (failure) => {
      const agentDir = "/tmp/openclaw-agent-profile-isolation";
      const coldProfileId = "openai:cold";
      const healthyProfileId = "anthropic:healthy";
      const keyRef =
        failure === "missing value"
          ? envRef("MISSING_OPENAI_PROFILE_KEY")
          : { source: "file" as const, provider: "clawrouter_key", id: "value" };
      const snapshot = await prepareProfiles(
        {
          [coldProfileId]: { type: "api_key", provider: "openai", keyRef },
          [healthyProfileId]: keyProfile("anthropic", "ANTHROPIC_PROFILE_KEY"),
        },
        {
          config: asConfig({ auth: { order: { openai: [coldProfileId] } } }),
          env: { ANTHROPIC_PROFILE_KEY: "anthropic-runtime-key" },
          agentDirs: [agentDir],
        },
      );

      expect(snapshot.degradedOwners).toMatchObject([
        {
          ownerKind: "account",
          ownerId: resolveAuthProfileSecretOwnerId({ agentDir, profileId: coldProfileId }),
          state: "unavailable",
          degradationState: "cold",
        },
      ]);
      const profiles = snapshot.authStores[0]?.store.profiles;
      expectRefOnly(profiles?.[coldProfileId], "openai", keyRef);
      expect(profiles?.[healthyProfileId]).toMatchObject({ key: "anthropic-runtime-key" });
      if (failure === "unconfigured provider") {
        expect(snapshot.degradedOwners?.[0]?.reason).toBe("secret provider is not configured");
        expectWarning(
          snapshot.warnings,
          "SECRETS_OWNER_UNAVAILABLE",
          coldProfileId,
          "key",
          agentDir,
        );
      }
    },
  );
});
