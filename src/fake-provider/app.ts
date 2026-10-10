import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Clock } from "../clock.ts";
import { silentLogger, type Logger } from "../logger.ts";
import { isExactInstant } from "../schemas.ts";
import { capturedAtFor, DEFAULT_DATASET, listPosts, metricsAt, type DatasetOptions } from "./dataset.ts";

/**
 * Provedor de métricas simulado. É um app HTTP separado da API: a API só fala com ele pelo
 * HttpProviderClient. Falhas podem ser programadas por conta (fila de faults, usada nos testes)
 * ou sorteadas (chaos, usado no teste de carga).
 */
// O simulado também valida o que recebe: as rotas de controle são entrada externa como qualquer outra.
const faultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ok") }),
  z.object({ type: z.literal("status"), status: z.number().int().min(400).max(599), retry_after: z.string().max(1_000).optional() }),
  z.object({ type: z.literal("timeout"), hang_ms: z.number().int().positive().max(120_000).optional() }),
  z.object({ type: z.literal("duplicate_items") }),
  // Responde certo, mas só depois de delay_ms, ignorando o cancelamento do cliente.
  z.object({ type: z.literal("slow"), delay_ms: z.number().int().positive().max(120_000) }),
  // Acrescenta à página um post publicado fora da janela pedida.
  z.object({ type: z.literal("out_of_window") }),
  // Devolve a página com captured_at fixo (ex.: 2099), como um provedor com relógio errado.
  z.object({ type: z.literal("captured_at"), value: z.string().datetime({ offset: true }) }),
  // Mesma medição (mesmo captured_at) com views somadas de `views`: um reenvio inconsistente.
  z.object({ type: z.literal("metrics_offset"), views: z.number().int() }),
  z.object({ type: z.literal("cursor_loop") }),
]);
export type Fault = z.infer<typeof faultSchema>;

const faultsBodySchema = z.object({
  platform: z.string().min(1).max(64),
  account: z.string().min(1).max(256),
  faults: z.array(faultSchema).max(1_000),
});

const rate = z.number().min(0).max(1);
const chaosSchema = z.object({
  serverErrorRate: rate,
  rateLimitRate: rate,
  rateLimitRetryAfter: z.string().max(100),
  longRateLimitRate: rate,
  longRateLimitRetryAfter: z.string().max(100),
  timeoutRate: rate,
  timeoutHangMs: z.number().int().positive().max(120_000),
  duplicateItemsRate: rate,
});
export type ChaosConfig = z.infer<typeof chaosSchema>;
const chaosBodySchema = z.union([z.object({ enabled: z.literal(false) }), chaosSchema]);

// Mesma conferência da API: fuso impossível viraria NaN no Date.parse e a página sairia vazia.
const instantParam = z.string().datetime({ offset: true }).refine(isExactInstant);
const postsQuerySchema = z.object({
  since: instantParam,
  until: instantParam,
  cursor: z.string().max(2_048).optional(),
});

const badRequest = (result: { success: boolean }, c: { json: (b: unknown, s: 400) => Response }) => {
  if (!result.success) return c.json({ error: "invalid_request" }, 400);
};

export interface FakeProviderOptions {
  clock: Clock;
  dataset?: DatasetOptions;
  pageSize?: number;
  /** Quando true, cada página repete o último post da anterior (post repetido entre páginas). */
  overlapPages?: boolean;
  chaos?: ChaosConfig | null;
  random?: () => number;
  /** Padrão: silencioso (testes). */
  logger?: Logger;
}

const PLATFORMS = new Set(["instagram", "tiktok", "youtube", "x"]);

export function createFakeProviderApp(options: FakeProviderOptions) {
  const dataset = options.dataset ?? DEFAULT_DATASET;
  const pageSize = options.pageSize ?? 10;
  const overlap = options.overlapPages ?? true;
  const random = options.random ?? Math.random;
  let chaos: ChaosConfig | null = options.chaos ?? null;
  const faults = new Map<string, Fault[]>();
  const stats: Record<string, number> = {};
  const count = (key: string) => (stats[key] = (stats[key] ?? 0) + 1);

  function nextFault(key: string): Fault | null {
    const queued = faults.get(key);
    if (queued && queued.length > 0) return queued.shift()!;
    if (!chaos) return null;
    let roll = random();
    const pick = (rate: number) => {
      const hit = roll < rate;
      roll -= rate;
      return hit;
    };
    if (pick(chaos.serverErrorRate)) return { type: "status", status: 503 };
    if (pick(chaos.rateLimitRate)) return { type: "status", status: 429, retry_after: chaos.rateLimitRetryAfter };
    if (pick(chaos.longRateLimitRate)) return { type: "status", status: 429, retry_after: chaos.longRateLimitRetryAfter };
    if (pick(chaos.timeoutRate)) return { type: "timeout", hang_ms: chaos.timeoutHangMs };
    if (pick(chaos.duplicateItemsRate)) return { type: "duplicate_items" };
    return null;
  }

  const app = new Hono();
  const logger = options.logger ?? silentLogger;
  // Sem isto o Hono escreveria o erro com console.error.
  app.onError((err, c) => {
    logger.error({ err, method: c.req.method, path: c.req.path }, "erro inesperado no provedor simulado");
    return c.json({ error: "internal_error" }, 500);
  });

  app.get("/v1/:platform/accounts/:account/posts", zValidator("query", postsQuerySchema, badRequest), async (c) => {
    const { platform, account } = c.req.param();
    count("requests");
    if (!PLATFORMS.has(platform)) return c.json({ error: "unknown_platform" }, 404);

    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token === "" || token === "revoked") {
      count("401");
      return c.json({ error: "invalid_token" }, 401);
    }

    const query = c.req.valid("query");
    const since = Date.parse(query.since);
    const until = Date.parse(query.until);

    const fault = nextFault(`${platform}/${account}`);
    if (fault?.type === "status") {
      count(String(fault.status));
      if (fault.retry_after !== undefined) c.header("Retry-After", fault.retry_after);
      return c.json({ error: "simulated" }, fault.status as 500);
    }
    if (fault?.type === "timeout") {
      count("timeout");
      await hang(c.req.raw.signal, fault.hang_ms ?? 30_000);
      return c.json({ error: "too_late" }, 504);
    }

    if (fault?.type === "slow") {
      count("slow");
      await new Promise((resolve) => setTimeout(resolve, fault.delay_ms));
    }

    const now = options.clock.now();
    const capturedAt = capturedAtFor(now);
    const visible = listPosts(platform, account, dataset)
      .filter((p) => p.publishedAt <= now.getTime() && p.publishedAt >= since && p.publishedAt < until)
      .sort((a, b) => b.publishedAt - a.publishedAt);

    const cursor = query.cursor;
    const offset = cursor ? decodeCursor(cursor) : 0;
    if (offset === null) return c.json({ error: "invalid_cursor" }, 400);

    let items = visible.slice(offset, offset + pageSize);
    const end = offset + pageSize;
    let nextCursor: string | null = null;
    if (end < visible.length) nextCursor = encodeCursor(overlap ? end - 1 : end);
    if (fault?.type === "cursor_loop") {
      count("cursor_loop");
      nextCursor = cursor ?? encodeCursor(0);
    }
    if (fault?.type === "duplicate_items") {
      count("duplicate_items");
      items = [...items, ...items];
    }
    if (fault?.type === "out_of_window") {
      count("out_of_window");
      items = [...items, { id: `${platform}-${account}-fora`, publishedAt: Date.parse("2020-01-01T00:00:00Z"), caption: "fora da janela" }];
    }

    count("200");
    return c.json({
      data: items.map((p) => ({
        id: p.id,
        published_at: new Date(p.publishedAt).toISOString(),
        caption: p.caption,
        captured_at: fault?.type === "captured_at" ? fault.value : new Date(capturedAt).toISOString(),
        metrics: withOffset(metricsAt(platform, account, p, capturedAt), fault),
      })),
      next_cursor: nextCursor,
    });
  });

  // Endpoints de controle, só existem no simulado.
  app.post("/__admin/faults", zValidator("json", faultsBodySchema, badRequest), (c) => {
    const body = c.req.valid("json");
    const key = `${body.platform}/${body.account}`;
    faults.set(key, [...(faults.get(key) ?? []), ...body.faults]);
    return c.json({ queued: faults.get(key)!.length });
  });

  app.put("/__admin/chaos", zValidator("json", chaosBodySchema, badRequest), (c) => {
    const body = c.req.valid("json");
    chaos = "enabled" in body ? null : body;
    return c.json({ chaos });
  });

  app.get("/__admin/stats", (c) => c.json(stats));

  /** O que o provedor considera verdade agora: base da verificação do teste de carga. */
  app.get("/__admin/accounts/:platform/:account/expected", (c) => {
    const { platform, account } = c.req.param();
    const now = options.clock.now();
    const capturedAt = capturedAtFor(now);
    const posts = listPosts(platform, account, dataset)
      .filter((p) => p.publishedAt <= now.getTime())
      .map((p) => ({ id: p.id, ...metricsAt(platform, account, p, capturedAt) }));
    const totals = posts.reduce(
      (acc, p) => ({ views: acc.views + p.views, likes: acc.likes + p.likes, comments: acc.comments + p.comments }),
      { views: 0, likes: 0, comments: 0 },
    );
    return c.json({ captured_at: new Date(capturedAt).toISOString(), posts, totals });
  });

  return app;
}

function withOffset(m: ReturnType<typeof metricsAt>, fault: Fault | null) {
  return fault?.type === "metrics_offset" ? { ...m, views: Math.max(0, m.views + fault.views) } : m;
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`).toString("base64url");
}

function decodeCursor(cursor: string): number | null {
  const match = /^o:(\d+)$/.exec(Buffer.from(cursor, "base64url").toString());
  return match ? Number(match[1]) : null;
}

function hang(signal: AbortSignal, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, maxMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
