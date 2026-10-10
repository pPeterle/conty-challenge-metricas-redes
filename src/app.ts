import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { zValidator } from "@hono/zod-validator";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodError, ZodSchema } from "zod";
import type { Clock, Sleep } from "./clock.ts";
import { createRepository, type ConnectionRow, type SyncRunRow } from "./db.ts";
import type { ProviderClient } from "./provider/types.ts";
import {
  connectionParamsSchema,
  createConnectionSchema,
  creatorParamsSchema,
  paginationSchema,
  postParamsSchema,
  replaceTokenSchema,
  syncWindowSchema,
  type SyncPolicy,
} from "./schemas.ts";
import { NeedsReauthError, RateLimitedError, SyncInProgressError, SyncService } from "./sync-service.ts";

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
  maxTotalWaitMs: 60_000,
  maxTotalAttempts: 300,
  staleRunMs: 15 * 60 * 1000,
  maxFutureSkewMs: 5 * 60 * 1000,
  maxRateLimitBlockMs: 24 * 3600 * 1000,
  maxPages: 100,
};

const MAX_BODY_BYTES = 16 * 1024;

function fail(c: Context, status: ContentfulStatusCode, code: string, message: string, extra: object = {}) {
  return c.json({ error: { code, message }, ...extra }, status);
}

function presentConnection(row: ConnectionRow) {
  // O token nunca volta na resposta.
  const { access_token: _token, ...rest } = row;
  return rest;
}

type Target = "json" | "query" | "param";

/** Único ponto que converte ZodError no erro padrão: 400, mensagem do primeiro problema e details. */
function validationError(c: Context, error: ZodError) {
  const seen = new Set<string>();
  const details = error.issues
    .map((i) => ({ path: i.path.join(".") || "(corpo)", message: i.message }))
    // O mesmo campo pode falhar em duas checagens com a mesma mensagem (formato e calendário).
    .filter((d) => !seen.has(`${d.path}:${d.message}`) && seen.add(`${d.path}:${d.message}`));
  return c.json({ error: { code: "validation_error", message: details[0]!.message, details } }, 400);
}

function validate<T extends ZodSchema, K extends Target>(target: K, schema: T) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) return validationError(c, result.error);
  });
}

/**
 * Antes do zod: exige content-type JSON e um corpo que seja JSON parseável. Sem isso o validador
 * do Hono responderia em texto puro, fora do formato de erro do repo.
 */
const requireJson: MiddlewareHandler = async (c, next) => {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) {
    return fail(c, 415, "unsupported_media_type", "envie o corpo como JSON com content-type: application/json");
  }
  const text = await c.req.text();
  if (text.trim() === "") return fail(c, 400, "validation_error", "corpo vazio; envie um objeto JSON");
  try {
    JSON.parse(text);
  } catch {
    return fail(c, 400, "validation_error", "corpo não é um JSON válido");
  }
  await next();
};

/** Garante objeto (o zod diria "Expected object, received array"; aqui a mensagem é nossa). */
const requireJsonObject: MiddlewareHandler = async (c, next) => {
  const body: unknown = await c.req.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail(c, 400, "validation_error", "corpo deve ser um objeto JSON");
  }
  await next();
};

const jsonBody = [requireJson, requireJsonObject] as const;

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

  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => fail(c, 413, "payload_too_large", `corpo maior que ${MAX_BODY_BYTES / 1024} KB`),
    }),
  );

  app.post("/connections", ...jsonBody, validate("json", createConnectionSchema), (c) => {
    const input = c.req.valid("json");
    const { row, created } = repo.createConnection({ id: newId(), ...input, created_at: deps.clock.now().toISOString() });
    if (!created) {
      return fail(c, 409, "connection_exists", "essa conta já está conectada", { connection: presentConnection(row) });
    }
    return c.json({ connection: presentConnection(row) }, 201);
  });

  app.get("/connections/:id", validate("param", connectionParamsSchema), (c) => {
    const conn = repo.getConnection(c.req.valid("param").id);
    if (!conn) return fail(c, 404, "connection_not_found", "conexão não encontrada");
    return c.json({ connection: presentConnection(conn) });
  });

  app.put("/connections/:id/token", validate("param", connectionParamsSchema), ...jsonBody, validate("json", replaceTokenSchema), (c) => {
    const id = c.req.valid("param").id;
    if (!repo.getConnection(id)) return fail(c, 404, "connection_not_found", "conexão não encontrada");
    const row = repo.replaceToken(id, c.req.valid("json").access_token)!;
    return c.json({ connection: presentConnection(row) });
  });

  app.post(
    "/connections/:id/sync",
    validate("param", connectionParamsSchema),
    ...jsonBody,
    validate("json", syncWindowSchema),
    async (c) => {
      const conn = repo.getConnection(c.req.valid("param").id);
      if (!conn) return fail(c, 404, "connection_not_found", "conexão não encontrada");

      let run: SyncRunRow;
      try {
        run = await sync.sync(conn, c.req.valid("json"));
      } catch (error) {
        if (error instanceof SyncInProgressError) {
          return fail(c, 409, "sync_em_andamento", error.message, { running_sync_run_id: error.runningId });
        }
        if (error instanceof NeedsReauthError) {
          return fail(c, 409, "reautorizacao_necessaria", error.message);
        }
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
    },
  );

  app.get("/connections/:id/sync-runs", validate("param", connectionParamsSchema), validate("query", paginationSchema(50)), (c) => {
    const conn = repo.getConnection(c.req.valid("param").id);
    if (!conn) return fail(c, 404, "connection_not_found", "conexão não encontrada");
    const page = c.req.valid("query");
    return c.json({ sync_runs: repo.listRuns(conn.id, page.limit, page.offset), ...page });
  });

  app.get("/sync-runs/:id", validate("param", connectionParamsSchema), (c) => {
    const run = repo.getRun(c.req.valid("param").id);
    if (!run) return fail(c, 404, "sync_run_not_found", "execução de sync não encontrada");
    return c.json({ sync_run: run, attempts: repo.listAttempts(run.id), anomalies: repo.listAnomalies(run.id) });
  });

  app.get("/connections/:id/posts", validate("param", connectionParamsSchema), validate("query", paginationSchema(100)), (c) => {
    const conn = repo.getConnection(c.req.valid("param").id);
    if (!conn) return fail(c, 404, "connection_not_found", "conexão não encontrada");
    const page = c.req.valid("query");
    const posts = repo.listPosts(conn.id, page.limit, page.offset).map((p) => ({
      external_post_id: p.external_post_id,
      published_at: p.published_at,
      caption: p.caption,
      metrics: { views: p.views, likes: p.likes, comments: p.comments },
      captured_at: p.captured_at,
      fetched_at: p.fetched_at,
      last_fetched_at: p.last_fetched_at,
      snapshots: p.snapshots,
    }));
    return c.json({ posts, ...page });
  });

  app.get(
    "/connections/:id/posts/:postId/snapshots",
    validate("param", postParamsSchema),
    validate("query", paginationSchema(100)),
    (c) => {
      const { id, postId } = c.req.valid("param");
      const conn = repo.getConnection(id);
      if (!conn) return fail(c, 404, "connection_not_found", "conexão não encontrada");
      if (!repo.postExists(conn.id, postId)) return fail(c, 404, "post_not_found", "post não encontrado nessa conexão");
      const page = c.req.valid("query");
      return c.json({ external_post_id: postId, snapshots: repo.listSnapshots(conn.id, postId, page.limit, page.offset), ...page });
    },
  );

  app.get("/connections/:id/metrics", validate("param", connectionParamsSchema), (c) => {
    const conn = repo.getConnection(c.req.valid("param").id);
    if (!conn) return fail(c, 404, "connection_not_found", "conexão não encontrada");
    const { last_fetched_at, ...totals } = repo.connectionTotals(conn.id);
    return c.json({ connection_id: conn.id, platform: conn.platform, totals, last_fetched_at });
  });

  app.get("/creators/:creatorId/metrics", validate("param", creatorParamsSchema), (c) => {
    const { creatorId } = c.req.valid("param");
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
