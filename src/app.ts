import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DatabaseSync } from "node:sqlite";
import type { Clock, Sleep } from "./clock.ts";
import { createRepository, type ConnectionRow, type SyncRunRow } from "./db.ts";
import { parseSyncWindow } from "./domain/window.ts";
import { PLATFORMS, type Platform, type ProviderClient } from "./provider/types.ts";
import { RateLimitedError, SyncService, type SyncPolicy } from "./sync-service.ts";

export interface AppDeps {
  db: DatabaseSync;
  clock: Clock;
  sleep: Sleep;
  provider: ProviderClient;
  policy: SyncPolicy;
  newId?: () => string;
}

export const DEFAULT_POLICY: SyncPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 30_000,
  maxPages: 100,
};

function fail(c: Context, status: ContentfulStatusCode, code: string, message: string, extra: object = {}) {
  return c.json({ error: { code, message }, ...extra }, status);
}

function presentConnection(row: ConnectionRow) {
  // O token nunca volta na resposta.
  const { access_token: _token, ...rest } = row;
  return rest;
}

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function createApp(deps: AppDeps) {
  const repo = createRepository(deps.db);
  const newId = deps.newId ?? randomUUID;
  const sync = new SyncService({ repo, provider: deps.provider, clock: deps.clock, sleep: deps.sleep, policy: deps.policy, newId });

  const app = new Hono();

  app.onError((err, c) => {
    console.error(err);
    return fail(c, 500, "internal_error", "erro interno inesperado");
  });
  app.notFound((c) => fail(c, 404, "not_found", "rota não encontrada"));

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/connections", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body !== "object" || body === null) return fail(c, 400, "validation_error", "corpo JSON inválido");
    const { creator_id, platform, external_account_id, access_token } = body as Record<string, unknown>;
    if (typeof creator_id !== "string" || !ID_PATTERN.test(creator_id)) {
      return fail(c, 400, "validation_error", "creator_id é obrigatório (letras, números, ponto, hífen ou sublinhado)");
    }
    if (typeof platform !== "string" || !PLATFORMS.includes(platform as Platform)) {
      return fail(c, 400, "validation_error", `platform deve ser um de: ${PLATFORMS.join(", ")}`);
    }
    if (typeof external_account_id !== "string" || !ID_PATTERN.test(external_account_id)) {
      return fail(c, 400, "validation_error", "external_account_id é obrigatório (letras, números, ponto, hífen ou sublinhado)");
    }
    if (typeof access_token !== "string" || access_token.trim() === "") {
      return fail(c, 400, "validation_error", "access_token é obrigatório (pode ser fictício)");
    }

    const { row, created } = repo.createConnection({
      id: newId(),
      creator_id,
      platform: platform as Platform,
      external_account_id,
      access_token,
      created_at: deps.clock.now().toISOString(),
    });
    if (!created) {
      return fail(c, 409, "connection_exists", "essa conta já está conectada", { connection: presentConnection(row) });
    }
    return c.json({ connection: presentConnection(row) }, 201);
  });

  app.get("/connections/:id", (c) => {
    const conn = repo.getConnection(c.req.param("id"));
    if (!conn) return fail(c, 404, "connection_not_found", "conexão não encontrada");
    return c.json({ connection: presentConnection(conn) });
  });

  app.post("/connections/:id/sync", async (c) => {
    const conn = repo.getConnection(c.req.param("id"));
    if (!conn) return fail(c, 404, "connection_not_found", "conexão não encontrada");
    const body = await c.req.json().catch(() => null);
    const parsed = parseSyncWindow(body);
    if (!parsed.ok) return fail(c, 400, "validation_error", parsed.message);

    let run: SyncRunRow;
    try {
      run = await sync.sync(conn, parsed.window);
    } catch (error) {
      if (error instanceof RateLimitedError) {
        c.header("Retry-After", retryAfterSeconds(error.retryAt, deps.clock));
        return fail(c, 503, "provider_rate_limited", `${error.message}; nenhuma chamada foi feita`, { retry_at: error.retryAt });
      }
      throw error;
    }

    if (run.status === "succeeded") return c.json({ sync_run: run }, 201);
    if (run.status === "rate_limited") {
      c.header("Retry-After", retryAfterSeconds(run.retry_at!, deps.clock));
      return fail(c, 503, run.error_code!, run.error_message!, { retry_at: run.retry_at, sync_run: run });
    }
    return fail(c, 502, run.error_code!, run.error_message!, { sync_run: run });
  });

  app.get("/connections/:id/sync-runs", (c) => {
    const conn = repo.getConnection(c.req.param("id"));
    if (!conn) return fail(c, 404, "connection_not_found", "conexão não encontrada");
    return c.json({ sync_runs: repo.listRuns(conn.id) });
  });

  app.get("/sync-runs/:id", (c) => {
    const run = repo.getRun(c.req.param("id"));
    if (!run) return fail(c, 404, "sync_run_not_found", "execução de sync não encontrada");
    return c.json({ sync_run: run, attempts: repo.listAttempts(run.id) });
  });

  app.get("/connections/:id/posts", (c) => {
    const conn = repo.getConnection(c.req.param("id"));
    if (!conn) return fail(c, 404, "connection_not_found", "conexão não encontrada");
    const posts = repo.listPosts(conn.id).map((p) => ({
      external_post_id: p.external_post_id,
      published_at: p.published_at,
      caption: p.caption,
      metrics: { views: p.views, likes: p.likes, comments: p.comments },
      captured_at: p.captured_at,
      fetched_at: p.fetched_at,
      last_fetched_at: p.last_fetched_at,
      snapshots: p.snapshots,
    }));
    return c.json({ posts });
  });

  app.get("/connections/:id/posts/:postId/snapshots", (c) => {
    const conn = repo.getConnection(c.req.param("id"));
    if (!conn) return fail(c, 404, "connection_not_found", "conexão não encontrada");
    const postId = c.req.param("postId");
    if (!repo.postExists(conn.id, postId)) return fail(c, 404, "post_not_found", "post não encontrado nessa conexão");
    return c.json({ external_post_id: postId, snapshots: repo.listSnapshots(conn.id, postId) });
  });

  app.get("/connections/:id/metrics", (c) => {
    const conn = repo.getConnection(c.req.param("id"));
    if (!conn) return fail(c, 404, "connection_not_found", "conexão não encontrada");
    const { last_fetched_at, ...totals } = repo.connectionTotals(conn.id);
    return c.json({ connection_id: conn.id, platform: conn.platform, totals, last_fetched_at });
  });

  app.get("/creators/:creatorId/metrics", (c) => {
    const creatorId = c.req.param("creatorId");
    const rows = repo.creatorTotalsByPlatform(creatorId);
    if (rows.length === 0) return fail(c, 404, "creator_not_found", "nenhuma conexão para esse criador");
    const totals = { posts: 0, views: 0, likes: 0, comments: 0 };
    for (const r of rows) {
      totals.posts += r.posts;
      totals.views += r.views;
      totals.likes += r.likes;
      totals.comments += r.comments;
    }
    const lastFetched = rows.map((r) => r.last_fetched_at).filter((v): v is string => v !== null).sort().at(-1) ?? null;
    return c.json({
      creator_id: creatorId,
      totals,
      by_platform: rows.map(({ last_fetched_at, ...r }) => ({ ...r, last_fetched_at })),
      last_fetched_at: lastFetched,
    });
  });

  return app;
}

function retryAfterSeconds(retryAt: string, clock: Clock): string {
  return String(Math.max(0, Math.ceil((Date.parse(retryAt) - clock.now().getTime()) / 1000)));
}
