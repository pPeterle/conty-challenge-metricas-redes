export interface RetryPolicy {
  /** Teto de tentativas por página (a primeira chamada conta). */
  maxAttempts: number;
  /** Primeira espera do backoff exponencial. */
  baseDelayMs: number;
  /** Maior espera do backoff exponencial. */
  maxDelayMs: number;
  /** Maior Retry-After que aceitamos esperar dentro de um sync. Acima disso o sync para. */
  maxRetryAfterMs: number;
}

export type AttemptFailure =
  | { kind: "transient"; reason: string }
  | { kind: "rate_limited"; retryAfterMs: number | null }
  | { kind: "permanent"; reason: string };

export type RetryDecision =
  | { action: "retry"; waitMs: number }
  | {
      action: "give_up";
      status: "failed" | "rate_limited";
      reason: "permanent" | "max_attempts" | "retry_after_above_cap";
      /** Só em rate_limited: quanto o provedor pediu para esperar. */
      retryAfterMs?: number;
    };

/** Espera depois da tentativa `attempt` (1 = primeira) que falhou de forma transitória. */
export function backoffDelayMs(attempt: number, policy: RetryPolicy): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
}

/**
 * Interpreta o header Retry-After (RFC 9110): inteiro de segundos ou HTTP-date.
 * Devolve null quando o header falta ou é inválido.
 */
export function parseRetryAfterMs(value: string | null | undefined, now: Date): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // Só o formato IMF-fixdate ("Thu, 01 Oct 2026 12:00:30 GMT"); Date.parse sozinho aceita até "-5".
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now.getTime());
}

export function decideRetry(failure: AttemptFailure, attempt: number, policy: RetryPolicy): RetryDecision {
  if (failure.kind === "permanent") {
    return { action: "give_up", status: "failed", reason: "permanent" };
  }

  if (failure.kind === "rate_limited") {
    // Sem Retry-After válido, cai no mesmo backoff das falhas transitórias.
    const waitMs = failure.retryAfterMs ?? backoffDelayMs(attempt, policy);
    if (waitMs > policy.maxRetryAfterMs) {
      return { action: "give_up", status: "rate_limited", reason: "retry_after_above_cap", retryAfterMs: waitMs };
    }
    if (attempt >= policy.maxAttempts) {
      return { action: "give_up", status: "rate_limited", reason: "max_attempts", retryAfterMs: waitMs };
    }
    return { action: "retry", waitMs };
  }

  if (attempt >= policy.maxAttempts) {
    return { action: "give_up", status: "failed", reason: "max_attempts" };
  }
  return { action: "retry", waitMs: backoffDelayMs(attempt, policy) };
}
