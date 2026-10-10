import { describe, expect, it } from "vitest";
import { envSchema, isExactInstant, syncPolicySchema, syncWindowSchema } from "../../src/schemas.ts";

describe("syncWindowSchema", () => {
  it("aceita janela ISO com fuso e converte para Date", () => {
    const r = syncWindowSchema.safeParse({ since: "2026-09-01T00:00:00Z", until: "2026-09-02T00:00:00-03:00", extra: 1 });
    expect(r.success && r.data).toEqual({ since: new Date("2026-09-01T00:00:00Z"), until: new Date("2026-09-02T03:00:00Z") });
  });

  it.each([
    ["sem fuso", { since: "2026-09-01T00:00:00", until: "2026-09-02T00:00:00Z" }],
    ["30 de fevereiro", { since: "2026-02-30T00:00:00Z", until: "2026-03-02T00:00:00Z" }],
    ["invertida", { since: "2026-09-02T00:00:00Z", until: "2026-09-01T00:00:00Z" }],
    ["vazia", { since: "2026-09-01T00:00:00Z", until: "2026-09-01T00:00:00Z" }],
    ["maior que 90 dias", { since: "2026-01-01T00:00:00Z", until: "2026-12-01T00:00:00Z" }],
    ["null", null],
  ])("recusa janela %s", (_name, input) => {
    expect(syncWindowSchema.safeParse(input).success).toBe(false);
  });
});

describe("configuração", () => {
  it("env com valores padrão é válido", () => {
    const env = envSchema.parse({});
    expect(env.SYNC_MAX_ATTEMPTS).toBe(5);
    expect(env.SYNC_MAX_RATE_LIMIT_BLOCK_MS).toBe(86_400_000);
  });

  it.each(["abc", "0", "-1", "1.5", "Infinity", "NaN"])("SYNC_MAX_ATTEMPTS=%s impede a subida", (value) => {
    expect(envSchema.safeParse({ SYNC_MAX_ATTEMPTS: value }).success).toBe(false);
  });

  it("política com teto NaN é recusada (senão o retry nunca pararia)", () => {
    const policy = {
      maxAttempts: Number("abc"),
      baseDelayMs: 1,
      maxDelayMs: 1,
      maxRetryAfterMs: 10,
      maxTotalWaitMs: 10,
      maxTotalAttempts: 10,
      staleRunMs: 10,
      maxRateLimitBlockMs: 10,
      maxPages: 1,
    };
    expect(syncPolicySchema.safeParse(policy).success).toBe(false);
    expect(syncPolicySchema.safeParse({ ...policy, maxAttempts: 3, maxRetryAfterMs: Number("abc") }).success).toBe(false);
  });
});

describe("isExactInstant", () => {
  it.each(["2026-09-01T00:00:00Z", "2026-09-01T00:00Z", "2024-02-29T23:59:59.999Z", "2026-09-01T21:00:00-03:00"])("%s é exato", (v) => {
    expect(isExactInstant(v)).toBe(true);
  });
  it.each(["2026-02-30T00:00:00Z", "2026-02-29T00:00:00Z", "2026-09-01T24:00:00Z", "2026-09-01T00:60:00Z", "2026-09-01", "1"])("%s não é", (v) => {
    expect(isExactInstant(v)).toBe(false);
  });
});
