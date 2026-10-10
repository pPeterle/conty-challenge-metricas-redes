import { describe, expect, it } from "vitest";
import { backoffDelayMs, decideRetry, parseRetryAfterMs, type RetryPolicy } from "../../src/domain/retry.ts";

const policy: RetryPolicy = { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 500, maxRetryAfterMs: 10_000 };
const now = new Date("2026-10-01T12:00:00.000Z");

describe("parseRetryAfterMs", () => {
  it("lê Retry-After em segundos", () => {
    expect(parseRetryAfterMs("7", now)).toBe(7_000);
    expect(parseRetryAfterMs(" 0 ", now)).toBe(0);
  });

  it("lê Retry-After em HTTP-date relativo ao relógio injetado", () => {
    expect(parseRetryAfterMs("Thu, 01 Oct 2026 12:00:30 GMT", now)).toBe(30_000);
  });

  it("HTTP-date no passado vira espera zero", () => {
    expect(parseRetryAfterMs("Thu, 01 Oct 2026 11:00:00 GMT", now)).toBe(0);
  });

  it("header ausente ou inválido devolve null", () => {
    expect(parseRetryAfterMs(null, now)).toBeNull();
    expect(parseRetryAfterMs("", now)).toBeNull();
    expect(parseRetryAfterMs("logo mais", now)).toBeNull();
    expect(parseRetryAfterMs("-5", now)).toBeNull();
  });
});

describe("backoffDelayMs", () => {
  it("dobra a cada tentativa e respeita o teto", () => {
    expect([1, 2, 3, 4, 5].map((a) => backoffDelayMs(a, policy))).toEqual([100, 200, 400, 500, 500]);
  });
});

describe("decideRetry", () => {
  it("falha transitória repete com backoff até o teto de tentativas", () => {
    const t = { kind: "transient", reason: "503" } as const;
    expect(decideRetry(t, 1, policy)).toEqual({ action: "retry", waitMs: 100 });
    expect(decideRetry(t, 3, policy)).toEqual({ action: "retry", waitMs: 400 });
    expect(decideRetry(t, 4, policy)).toEqual({ action: "give_up", status: "failed", reason: "max_attempts" });
  });

  it("erro permanente (4xx) não repete nem na primeira tentativa", () => {
    expect(decideRetry({ kind: "permanent", reason: "401" }, 1, policy)).toEqual({
      action: "give_up",
      status: "failed",
      reason: "permanent",
    });
  });

  it("429 espera exatamente o Retry-After pedido", () => {
    expect(decideRetry({ kind: "rate_limited", retryAfterMs: 2_500 }, 1, policy)).toEqual({ action: "retry", waitMs: 2_500 });
  });

  it("429 com Retry-After igual ao teto ainda espera", () => {
    expect(decideRetry({ kind: "rate_limited", retryAfterMs: 10_000 }, 1, policy)).toEqual({ action: "retry", waitMs: 10_000 });
  });

  it("429 com Retry-After acima do teto para sem esperar", () => {
    expect(decideRetry({ kind: "rate_limited", retryAfterMs: 10_001 }, 1, policy)).toEqual({
      action: "give_up",
      status: "rate_limited",
      reason: "retry_after_above_cap",
      retryAfterMs: 10_001,
    });
  });

  it("429 sem Retry-After usa o backoff", () => {
    expect(decideRetry({ kind: "rate_limited", retryAfterMs: null }, 2, policy)).toEqual({ action: "retry", waitMs: 200 });
  });

  it("429 repetido também conta para o teto de tentativas", () => {
    expect(decideRetry({ kind: "rate_limited", retryAfterMs: 1_000 }, 4, policy)).toEqual({
      action: "give_up",
      status: "rate_limited",
      reason: "max_attempts",
      retryAfterMs: 1_000,
    });
  });
});
