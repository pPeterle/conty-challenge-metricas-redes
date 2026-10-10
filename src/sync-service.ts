import type { Clock, Sleep } from "./clock.ts";
import type { ConnectionRow, Repository, SyncRunRow } from "./db.ts";
import { decideRetry, MAX_PARSED_RETRY_AFTER_MS, parseRetryAfterMs, type AttemptFailure } from "./domain/retry.ts";
import type { ProviderClient, ProviderPage, ProviderResponse } from "./provider/types.ts";
import { syncPolicySchema, type SyncPolicy, type SyncWindow } from "./schemas.ts";

export type { SyncPolicy };

export interface SyncServiceDeps {
  repo: Repository;
  provider: ProviderClient;
  clock: Clock;
  sleep: Sleep;
  policy: SyncPolicy;
  newId: () => string;
}

/** O provedor pediu para esperar e ainda não passou o prazo: nem chamamos o provedor. */
export class RateLimitedError extends Error {
  constructor(readonly retryAt: string) {
    super(`provedor pediu para aguardar até ${retryAt}`);
  }
}

type PageOutcome =
  | { ok: true; page: ProviderPage }
  | { ok: false; status: "failed" | "rate_limited"; code: string; message: string; retryAt?: string };

export class SyncService {
  constructor(private readonly deps: SyncServiceDeps) {
    // Teto NaN ou negativo desligaria o limite de tentativas: falha já na construção.
    syncPolicySchema.parse(deps.policy);
  }

  async sync(connection: ConnectionRow, window: SyncWindow): Promise<SyncRunRow> {
    const { repo, clock, newId } = this.deps;
    const now = clock.now();
    if (connection.rate_limited_until && Date.parse(connection.rate_limited_until) > now.getTime()) {
      throw new RateLimitedError(connection.rate_limited_until);
    }

    const runId = newId();
    repo.startRun({
      id: runId,
      connectionId: connection.id,
      since: window.since.toISOString(),
      until: window.until.toISOString(),
      startedAt: now.toISOString(),
    });

    try {
      return await this.paginate(runId, connection, window);
    } catch (error) {
      // Não deixa a execução presa em running quando algo inesperado quebra no meio.
      try {
        this.finish(runId, "failed", "internal_error", "erro interno durante o sync");
      } catch {
        // o banco também pode ser a causa; o erro original é o que importa
      }
      throw error;
    }
  }

  private async paginate(runId: string, connection: ConnectionRow, window: SyncWindow): Promise<SyncRunRow> {
    const { repo, clock } = this.deps;
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    const budget = { waitedMs: 0 };

    for (let pageNumber = 1; ; pageNumber++) {
      if (pageNumber > this.deps.policy.maxPages) {
        return this.finish(runId, "failed", "too_many_pages", `paginação passou do limite de ${this.deps.policy.maxPages} páginas`);
      }

      const outcome = await this.fetchPageWithRetry(runId, connection, window, cursor, pageNumber, budget);
      if (!outcome.ok) {
        if (outcome.retryAt) repo.markRateLimited(connection.id, outcome.retryAt);
        return this.finish(runId, outcome.status, outcome.code, outcome.message, outcome.retryAt);
      }

      // fetched_at é o relógio da nossa busca; captured_at vem do provedor dentro de cada post.
      repo.ingestPage(runId, connection.id, outcome.page.posts, clock.now().toISOString());

      const next = outcome.page.nextCursor;
      if (next === null) return this.finish(runId, "succeeded");
      if (seenCursors.has(next) || next === cursor) {
        return this.finish(runId, "failed", "provider_cursor_loop", "provedor devolveu um cursor que já foi visitado");
      }
      seenCursors.add(next);
      cursor = next;
    }
  }

  private async fetchPageWithRetry(
    runId: string,
    connection: ConnectionRow,
    window: SyncWindow,
    cursor: string | null,
    page: number,
    budget: { waitedMs: number },
  ): Promise<PageOutcome> {
    const { provider, clock, sleep, policy, repo } = this.deps;

    for (let attempt = 1; ; attempt++) {
      const response = await provider.fetchPostsPage({
        platform: connection.platform,
        externalAccountId: connection.external_account_id,
        accessToken: connection.access_token,
        since: window.since,
        until: window.until,
        cursor,
      });
      const at = clock.now();

      if (response.kind === "ok") {
        repo.recordAttempt(runId, { page, attempt, outcome: "ok", http_status: response.httpStatus, detail: null, wait_ms: 0, at: at.toISOString() });
        return { ok: true, page: response.page };
      }

      const failure = toFailure(response, at);
      const decision = decideRetry(failure, attempt, policy, budget.waitedMs);
      repo.recordAttempt(runId, {
        page,
        attempt,
        outcome: response.kind,
        http_status: response.httpStatus,
        detail: describe(response),
        wait_ms: decision.action === "retry" ? decision.waitMs : 0,
        at: at.toISOString(),
      });

      if (decision.action === "retry") {
        budget.waitedMs += decision.waitMs;
        await sleep(decision.waitMs);
        continue;
      }

      if (decision.status === "rate_limited") {
        const askedMs = decision.retryAfterMs ?? 0;
        // Um Retry-After absurdo (dias, anos) não pode travar a conexão para sempre.
        const blockMs = Math.min(askedMs, policy.maxRateLimitBlockMs);
        const retryAt = new Date(at.getTime() + blockMs).toISOString();
        const reasons: Record<string, string> = {
          retry_after_above_cap: askedMs >= MAX_PARSED_RETRY_AFTER_MS
            ? `provedor pediu um ano ou mais de espera, acima do teto de ${policy.maxRetryAfterMs}ms`
            : `provedor pediu ${askedMs}ms de espera, acima do teto de ${policy.maxRetryAfterMs}ms`,
          max_attempts: `provedor continuou respondendo 429 depois de ${attempt} tentativas`,
          wait_budget_exceeded: `esperar mais ${askedMs}ms passaria do orçamento de ${policy.maxTotalWaitMs}ms por sync`,
        };
        let message = reasons[decision.reason]!;
        if (blockMs < askedMs) message += `; conexão bloqueada só até ${retryAt} (teto de ${policy.maxRateLimitBlockMs}ms)`;
        return { ok: false, status: "rate_limited", code: "provider_rate_limited", message, retryAt };
      }
      if (decision.reason === "permanent") {
        return { ok: false, status: "failed", code: "provider_rejected", message: describe(response) };
      }
      if (decision.reason === "wait_budget_exceeded") {
        return {
          ok: false,
          status: "failed",
          code: "provider_unavailable",
          message: `orçamento de espera de ${policy.maxTotalWaitMs}ms por sync esgotado: ${describe(response)}`,
        };
      }
      return {
        ok: false,
        status: "failed",
        code: "provider_unavailable",
        message: `falha transitória persistiu após ${attempt} tentativas: ${describe(response)}`,
      };
    }
  }

  private finish(runId: string, status: SyncRunRow["status"], code?: string, message?: string, retryAt?: string): SyncRunRow {
    this.deps.repo.finishRun(runId, {
      status,
      finishedAt: this.deps.clock.now().toISOString(),
      errorCode: code,
      errorMessage: message,
      retryAt,
    });
    return this.deps.repo.getRun(runId)!;
  }
}

function toFailure(response: Exclude<ProviderResponse, { kind: "ok" }>, now: Date): AttemptFailure {
  switch (response.kind) {
    case "rate_limited":
      return { kind: "rate_limited", retryAfterMs: parseRetryAfterMs(response.retryAfter, now) };
    case "transient":
      return { kind: "transient", reason: response.reason };
    case "permanent":
      return { kind: "permanent", reason: response.reason };
  }
}

function describe(response: Exclude<ProviderResponse, { kind: "ok" }>): string {
  if (response.kind === "rate_limited") return `429 com Retry-After=${response.retryAfter?.slice(0, 100) ?? "(ausente)"}`;
  return response.reason.slice(0, 300);
}
