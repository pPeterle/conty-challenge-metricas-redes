import type { Clock, Sleep } from "./clock.ts";
import type { ConnectionRow, Repository, SyncRunRow } from "./db.ts";
import { decideRetry, parseRetryAfterMs, type AttemptFailure, type RetryPolicy } from "./domain/retry.ts";
import type { SyncWindow } from "./domain/window.ts";
import type { ProviderClient, ProviderPage, ProviderResponse } from "./provider/types.ts";

export interface SyncPolicy extends RetryPolicy {
  /** Proteção contra paginação sem fim. */
  maxPages: number;
}

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
  constructor(private readonly deps: SyncServiceDeps) {}

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

    let cursor: string | null = null;
    const seenCursors = new Set<string>();

    for (let pageNumber = 1; ; pageNumber++) {
      if (pageNumber > this.deps.policy.maxPages) {
        return this.finish(runId, "failed", "too_many_pages", `paginação passou do limite de ${this.deps.policy.maxPages} páginas`);
      }

      const outcome = await this.fetchPageWithRetry(runId, connection, window, cursor, pageNumber);
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
      const decision = decideRetry(failure, attempt, policy);
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
        await sleep(decision.waitMs);
        continue;
      }

      if (decision.status === "rate_limited") {
        const retryAt = new Date(at.getTime() + (decision.retryAfterMs ?? 0)).toISOString();
        const message = decision.reason === "retry_after_above_cap"
          ? `provedor pediu ${decision.retryAfterMs}ms de espera, acima do teto de ${policy.maxRetryAfterMs}ms`
          : `provedor continuou respondendo 429 depois de ${attempt} tentativas`;
        return { ok: false, status: "rate_limited", code: "provider_rate_limited", message, retryAt };
      }
      if (decision.reason === "permanent") {
        return { ok: false, status: "failed", code: "provider_rejected", message: describe(response) };
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
  if (response.kind === "rate_limited") return `429 com Retry-After=${response.retryAfter ?? "(ausente)"}`;
  return response.reason;
}
