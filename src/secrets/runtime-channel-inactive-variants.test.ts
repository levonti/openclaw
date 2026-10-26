/** Tests inactive channel variants in secrets runtime collection. */
import { describe, expect, it } from "vitest";
import "./runtime-channel-inactive-variants.test-support.ts";
import { getPath } from "./path-utils.js";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

const envRef = (id: string) => ({ source: "env", provider: "default", id }) as const;
const slackWork = {
  mode: "socket",
  botToken: "xoxb-work",
  appToken: "xapp-work",
  userToken: "xoxp-work",
  signingSecret: "signing-work",
  relay: { authToken: "relay-work" },
};
const slackValues = {
  botToken: "xoxb-default",
  appToken: "xapp-default",
  userToken: "xoxp-default",
  signingSecret: "signing-default",
  relay: { authToken: "relay-default" },
};
function slackCredential(field: keyof typeof slackValues) {
  const ref = envRef(field.toUpperCase());
  return field === "relay"
    ? { url: "https://relay.example.invalid", gatewayId: "fixture", authToken: ref }
    : ref;
}

function expectInactive(snapshot: Awaited<ReturnType<typeof prepare>>, path: string, ref: unknown) {
  expect(getPath(snapshot.config, path.split("."))).toEqual(ref);
  expect(snapshot.warnings).toContainEqual(
    expect.objectContaining({ code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE", path }),
  );
}

function prepare(
  channel: string,
  config: Record<string, unknown>,
  env: Record<string, string> = {},
) {
  return prepareSecretsRuntimeSnapshot({
    config: asConfig({ channels: { [channel]: config } }),
    env,
    agentDirs: ["/tmp/openclaw-agent-main"],
    loadAuthStore: () => loadAuthStoreWithProfiles({}),
  });
}

describe("secrets runtime snapshot channel inactive variants", () => {
  it.each<[string, keyof typeof slackValues, keyof typeof slackValues]>([
    ["socket", "botToken", "appToken"],
    ["http", "botToken", "signingSecret"],
    ["relay", "botToken", "relay"],
    ["socket", "userToken", "appToken"],
  ])("resolves implicit Slack defaults in %s mode with %s", async (mode, token, transport) => {
    const fields = [token, transport];
    const credentials = Object.fromEntries(fields.map((field) => [field, slackCredential(field)]));
    const env = Object.fromEntries(
      fields.map((field) => [
        field.toUpperCase(),
        field === "relay" ? slackValues.relay.authToken : slackValues[field],
      ]),
    );
    const snapshot = await prepare(
      "slack",
      {
        mode,
        ...credentials,
        ...(token === "userToken" ? { postAs: "user" } : {}),
        accounts: { work: slackWork },
      },
      env,
    );
    expect(snapshot.config.channels?.slack).toMatchObject(
      Object.fromEntries(fields.map((field) => [field, slackValues[field]])),
    );
    expect(snapshot.warnings).toEqual([]);
  });

  it.each([
    {
      channel: "googlechat",
      credentials: { serviceAccount: envRef("GOOGLECHAT_DEFAULT") },
      work: { serviceAccount: "work-service-account-json" },
      resolved: { serviceAccount: "default-service-account-json" },
    },
    {
      channel: "mattermost",
      credentials: {
        baseUrl: "https://mattermost.example.invalid",
        botToken: envRef("MATTERMOST_DEFAULT"),
      },
      work: { baseUrl: "https://work.example.invalid", botToken: "work-bot-token" },
      resolved: { botToken: "default-bot-token" },
    },
    {
      channel: "x",
      credentials: {
        clientId: "fixture-client",
        clientSecret: envRef("X_CLIENT_SECRET"),
        refreshToken: envRef("X_REFRESH_TOKEN"),
      },
      work: {
        clientSecret: "work-secret",
        refreshToken: "work-refresh",
        bearerToken: "work-bearer",
      },
      resolved: { clientSecret: "default-client-secret", refreshToken: "default-refresh-token" },
    },
  ])("resolves implicit $channel defaults despite named overrides", async (row) => {
    const snapshot = await prepare(
      row.channel,
      { ...row.credentials, accounts: { work: { enabled: true, ...row.work } } },
      {
        GOOGLECHAT_DEFAULT: "default-service-account-json",
        MATTERMOST_DEFAULT: "default-bot-token",
        X_CLIENT_SECRET: "default-client-secret",
        X_REFRESH_TOKEN: "default-refresh-token",
      },
    );
    expect(getPath(snapshot.config, ["channels", row.channel])).toMatchObject(row.resolved);
    expect(snapshot.warnings).toEqual([]);
  });

  it.each([
    ["default", true, "xapp-default"],
    ["Default", true, "xapp-default"],
    [" default ", true, "xapp-default"],
    ["work", false, "xapp-default"],
    ["work", true, undefined],
  ] as const)(
    "keeps unused Slack root refs inactive: account=%s, enabled=%s, appToken=%s",
    async (accountId, enabled, appToken) => {
      const snapshot = await prepare("slack", {
        enabled,
        botToken: envRef("MISSING_SLACK_BOT"),
        appToken,
        accounts: { [accountId]: { botToken: "xoxb-work", appToken: "xapp-work" } },
      });

      expectInactive(snapshot, "channels.slack.botToken", envRef("MISSING_SLACK_BOT"));
    },
  );

  it.each(["channel", "account"])("ignores disabled IRC %s nickserv", async (scope) => {
    const nickserv = {
      enabled: false,
      password: envRef("MISSING_IRC_PASSWORD"),
    };
    const irc =
      scope === "channel" ? { nickserv } : { accounts: { work: { enabled: true, nickserv } } };
    const snapshot = await prepare("irc", irc);
    const path = `channels.irc.${scope === "account" ? "accounts.work." : ""}nickserv.password`;
    expect(getPath(snapshot.config, path.split("."))).toEqual(nickserv.password);
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(path);
  });

  it.each([
    ["socket", "signingSecret"],
    ["http", "appToken"],
  ])("ignores Slack %s-inactive %s", async (mode, field) => {
    const ref = envRef("MISSING_SLACK_CREDENTIAL");
    const workRef = envRef("MISSING_SLACK_WORK_APP_TOKEN");
    const snapshot = await prepare("slack", {
      mode,
      [field]: ref,
      accounts: {
        work: { enabled: true, mode, ...(field === "appToken" ? { [field]: workRef } : {}) },
      },
    });
    const paths = [
      `channels.slack.${field}`,
      ...(field === "appToken" ? [`channels.slack.accounts.work.${field}`] : []),
    ];
    for (const path of paths) {
      expect(getPath(snapshot.config, path.split("."))).toEqual(
        path.includes("accounts.work") ? workRef : ref,
      );
      expect(snapshot.warnings.map((warning) => warning.path)).toContain(path);
    }
  });

  it.each<[string, string | undefined]>([
    ["default", "https://mattermost.example.invalid"],
    ["work", undefined],
  ])(
    "keeps unused Mattermost root refs inactive: account=%s, baseUrl=%s",
    async (accountId, baseUrl) => {
      const botToken = envRef("MISSING_MATTERMOST_DEFAULT");
      const snapshot = await prepare("mattermost", {
        baseUrl,
        botToken,
        accounts: {
          [accountId]: { baseUrl: "https://work.example.invalid", botToken: "work-bot-token" },
        },
      });

      expectInactive(snapshot, "channels.mattermost.botToken", botToken);
    },
  );

  it("keeps top-level Google Chat serviceAccount inactive when an explicit default overrides it", async () => {
    const snapshot = await prepare(
      "googlechat",
      {
        serviceAccount: envRef("MISSING_GOOGLECHAT_BASE_SERVICE_ACCOUNT"),
        accounts: {
          default: {
            enabled: true,
            serviceAccount: envRef("GOOGLECHAT_DEFAULT_SERVICE_ACCOUNT"),
          },
        },
      },
      { GOOGLECHAT_DEFAULT_SERVICE_ACCOUNT: "default-service-account-json" },
    );

    expect(snapshot.config.channels?.googlechat?.serviceAccount).toEqual(
      envRef("MISSING_GOOGLECHAT_BASE_SERVICE_ACCOUNT"),
    );
    expect(snapshot.config.channels?.googlechat?.accounts?.default?.serviceAccount).toBe(
      "default-service-account-json",
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.googlechat.serviceAccount",
    );
  });
});
