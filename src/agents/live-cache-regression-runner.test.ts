import { describe, expect, it } from "vitest";
import {
  assertAgainstBaseline,
  evaluateAgainstBaseline,
  isAnthropicToolProbeDrift,
  resolveCacheProbeMaxTokens,
  resolveLiveCacheProviderPool,
  shouldAcceptEmptyCacheProbe,
  shouldRetryBaselineFindings,
  shouldRetryCacheProbeText,
  type BaselineFindings,
  type CacheRun,
} from "./live-cache-regression-policy.js";
import {
  LiveCachePrerequisiteSkip,
  toLiveCachePrerequisiteSkip,
} from "./live-cache-test-support.js";
import { ProviderAuthError } from "./model-auth-runtime-shared.js";

function cacheRun(usage: CacheRun["usage"], hitRate = 0.999): CacheRun {
  return { hitRate, usage, suffix: "hit", text: "CACHE-OK hit" };
}

const emptyFindings = (): BaselineFindings => ({ regressions: [], warnings: [] });

describe("live cache regression runner", () => {
  it("keeps OpenAI text cache floor misses advisory", () => {
    const result = emptyFindings();
    assertAgainstBaseline({
      lane: "stable",
      provider: "openai",
      result: { best: cacheRun({ cacheRead: 0, cacheWrite: 0, input: 5_034 }, 0) },
      ...result,
    });

    expect(result).toStrictEqual({
      regressions: [],
      warnings: ["openai:stable cacheRead=0 < min=4608", "openai:stable hitRate=0.000 < min=0.900"],
    });
  });

  it("retries hard cache baseline misses once", () => {
    const hard = { regressions: ["anthropic:image cacheRead=0 < min=4500"], warnings: [] };
    const advisory = { regressions: [], warnings: ["openai:image cacheRead=0 < min=3840"] };
    expect(shouldRetryBaselineFindings(hard, 1)).toBe(true);
    expect(shouldRetryBaselineFindings(hard, 2)).toBe(false);
    expect(shouldRetryBaselineFindings(advisory, 1)).toBe(false);
  });

  it.each([
    ["openai", "openai-responses", "gpt-5.5", "warnings"],
    ["anthropic", "anthropic-messages", "claude-sonnet-4-6", "regressions"],
  ] as const)("classifies missing %s prerequisites", async (provider, api, model, severity) => {
    const result = emptyFindings();
    const summary = { [provider]: {} };
    const message = `No ${provider} ${api} model available in registry.`;
    const resolved = await resolveLiveCacheProviderPool({
      config: {
        provider,
        api,
        envVar: `OPENCLAW_LIVE_${provider.toUpperCase()}_CACHE_MODEL`,
        preferredModelIds: [model],
      },
      resolver: async () => {
        throw new LiveCachePrerequisiteSkip(provider, message);
      },
      ...result,
      summary,
    });
    expect(resolved).toBeUndefined();
    expect(summary[provider]).toEqual({ skipped: true });
    expect(result).toStrictEqual({
      ...emptyFindings(),
      [severity]: [`${provider} skipped: ${message}`],
    });
  });

  it("classifies missing provider auth as a live-cache prerequisite", () => {
    const skip = toLiveCachePrerequisiteSkip(
      "openai",
      new ProviderAuthError("missing-provider-auth", "openai", "No API key found."),
    );

    expect(skip).toBeInstanceOf(LiveCachePrerequisiteSkip);
    expect(skip).toMatchObject({ provider: "openai", message: "No API key found." });
  });

  it("retries a cache probe twice when provider text misses the sentinel", () => {
    const retry = (attempt: number, text = "") =>
      shouldRetryCacheProbeText({ attempt, text, suffix: "openai-stable-hit-a" });
    expect(retry(1)).toBe(true);
    expect(retry(2)).toBe(true);
    expect(retry(3)).toBe(false);
    expect(retry(1, "I saw openai-stable-hit-a.")).toBe(true);
    expect(retry(1, "CACHE-OK openai-stable-hit-a")).toBe(false);
  });

  it("keeps cache probes above the provider empty-output floor", () => {
    const tokens = (maxTokens: number) =>
      resolveCacheProbeMaxTokens({ maxTokens, providerTag: "openai" });
    expect(tokens(32)).toBe(1024);
    expect(tokens(2048)).toBe(2048);
  });

  it("classifies Anthropic tool-only probe misses as provider drift", () => {
    expect(isAnthropicToolProbeDrift(new Error("expected tool call for noop"))).toBe(true);
    expect(
      isAnthropicToolProbeDrift(new Error('expected tool-only response for noop, got "ok"')),
    ).toBe(true);
    expect(isAnthropicToolProbeDrift(new Error("other failure"))).toBe(false);
  });

  it("accepts empty cache probe text only when usage is observable", () => {
    const accept = (usage: Parameters<typeof shouldAcceptEmptyCacheProbe>[0]["usage"], text = "") =>
      shouldAcceptEmptyCacheProbe({ usage, text, providerTag: "openai" });
    expect(accept({ input: 5_000 })).toBe(true);
    expect(accept({ cacheRead: 4_608 })).toBe(true);
    expect(accept({ input: 5_000 }, "wrong")).toBe(false);
    expect(accept({})).toBe(false);
  });

  it.each([
    { hitRate: 0.999, usage: { cacheRead: 5_741, cacheWrite: 0, input: 3 }, regressions: [] },
    {
      hitRate: 0,
      usage: { cacheRead: 0, cacheWrite: 0, input: 5_741 },
      regressions: ["anthropic:image warmup cacheWrite=0 < min=1"],
    },
  ])(
    "requires cache evidence in the warmup ($hitRate hit rate)",
    ({ hitRate, usage, regressions }) => {
      const findings = evaluateAgainstBaseline({
        lane: "image",
        provider: "anthropic",
        result: {
          best: cacheRun({ cacheRead: 5_742, cacheWrite: 0, input: 3 }),
          warmup: cacheRun(usage, hitRate),
        },
      });

      expect(findings).toEqual({ regressions, warnings: [] });
    },
  );
});
