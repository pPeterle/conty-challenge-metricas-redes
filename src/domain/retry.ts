import type { SyncPolicy } from "../schemas.ts";

/**
 * maxAttempts: teto de tentativas por página (a primeira chamada conta).
 * baseDelayMs/maxDelayMs: backoff exponencial das falhas transitórias.
 * maxRetryAfterMs: maior Retry-After que aceitamos esperar; acima disso o sync para.
 * maxTotalWaitMs / maxTotalAttempts: orçamento de espera somada e de chamadas de um sync inteiro.
 */
export type RetryPolicy = Pick<
  SyncPolicy,
  "maxAttempts" | "baseDelayMs" | "maxDelayMs" | "maxRetryAfterMs" | "maxTotalWaitMs" | "maxTotalAttempts"
>;

/** O que o sync inteiro já gastou: espera somada e chamadas feitas (inclusive a que acabou de falhar). */
export interface SyncSpend {
  waitedMs: number;
  attempts: number;
}

export type AttemptFailure =
  | { kind: "transient"; reason: string }
  | { kind: "rate_limited"; retryAfterMs: number | null }
  | { kind: "permanent"; reason: string };

export type GiveUpReason =
  | "permanent"
  | "max_attempts"
  | "retry_after_above_cap"
  | "wait_budget_exceeded"
  | "attempt_budget_exceeded";

export type RetryDecision =
  | { action: "retry"; waitMs: number }
  | {
      action: "give_up";
      status: "failed" | "rate_limited";
      reason: GiveUpReason;
      /** Só em rate_limited: quanto o provedor pediu para esperar. */
      retryAfterMs?: number;
    };

/** Teto do que o parse devolve. Garante número finito para somar a datas sem estourar. */
export const MAX_PARSED_RETRY_AFTER_MS = 365 * 24 * 3600 * 1000;

/** Espera depois da tentativa `attempt` (1 = primeira) que falhou de forma transitória. */
export function backoffDelayMs(attempt: number, policy: RetryPolicy): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(attempt - 1, 30));
}

const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Interpreta o header Retry-After (RFC 9110): inteiro de segundos ou HTTP-date no formato
 * IMF-fixdate. Devolve null quando o header falta ou é inválido. O resultado nunca passa de
 * MAX_PARSED_RETRY_AFTER_MS.
 */
export function parseRetryAfterMs(value: string | null | undefined, now: Date): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) {
    // Mais de 12 dígitos já passa de um ano em segundos; evita Number("9".repeat(400)) = Infinity.
    const ms = trimmed.length > 12 ? Infinity : Number(trimmed) * 1000;
    return Math.min(ms, MAX_PARSED_RETRY_AFTER_MS);
  }
  if (!IMF_FIXDATE.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  // A volta para texto recusa data impossível (31 Feb) e dia da semana errado.
  if (Number.isNaN(at) || new Date(at).toUTCString() !== trimmed) return null;
  return Math.min(Math.max(0, at - now.getTime()), MAX_PARSED_RETRY_AFTER_MS);
}

/**
 * Decide o que fazer depois de uma tentativa que falhou. `attempt` conta só a página atual;
 * `spent` é o gasto do sync inteiro, que não pode estourar os orçamentos.
 */
export function decideRetry(
  failure: AttemptFailure,
  attempt: number,
  policy: RetryPolicy,
  spent: SyncSpend = { waitedMs: 0, attempts: attempt },
): RetryDecision {
  const { waitedMs } = spent;
  const attemptsLeft = spent.attempts < policy.maxTotalAttempts;
  if (failure.kind === "permanent") {
    return { action: "give_up", status: "failed", reason: "permanent" };
  }

  if (failure.kind === "rate_limited") {
    // Sem Retry-After válido, cai no mesmo backoff das falhas transitórias.
    const waitMs = failure.retryAfterMs ?? backoffDelayMs(attempt, policy);
    const giveUp = (reason: GiveUpReason): RetryDecision => ({ action: "give_up", status: "rate_limited", reason, retryAfterMs: waitMs });
    if (waitMs > policy.maxRetryAfterMs) return giveUp("retry_after_above_cap");
    if (attempt >= policy.maxAttempts) return giveUp("max_attempts");
    if (!attemptsLeft) return giveUp("attempt_budget_exceeded");
    if (waitedMs + waitMs > policy.maxTotalWaitMs) return giveUp("wait_budget_exceeded");
    return { action: "retry", waitMs };
  }

  if (attempt >= policy.maxAttempts) {
    return { action: "give_up", status: "failed", reason: "max_attempts" };
  }
  if (!attemptsLeft) {
    return { action: "give_up", status: "failed", reason: "attempt_budget_exceeded" };
  }
  const waitMs = backoffDelayMs(attempt, policy);
  if (waitedMs + waitMs > policy.maxTotalWaitMs) {
    return { action: "give_up", status: "failed", reason: "wait_budget_exceeded" };
  }
  return { action: "retry", waitMs };
}
