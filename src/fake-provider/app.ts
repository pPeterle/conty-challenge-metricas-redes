import { Hono } from "hono";
import type { Clock } from "../clock.ts";
import { capturedAtFor, DEFAULT_DATASET, listPosts, metricsAt, type DatasetOptions } from "./dataset.ts";

/**
 * Provedor de métricas simulado. É um app HTTP separado da API: a API só fala com ele pelo
 * HttpProviderClient. Falhas podem ser programadas por conta (fila de faults, usada nos testes)
 * ou sorteadas (chaos, usado no teste de carga).
 */
export type Fault =
  | { type: "ok" }
  | { type: "status"; status: number; retry_after?: string }
  | { type: "timeout"; hang_ms?: number }
  | { type: "duplicate_items" }
  | { type: "cursor_loop" };

export interface ChaosConfig {
  serverErrorRate: number;
  rateLimitRate: number;
  rateLimitRetryAfter: string;
  longRateLimitRate: number;
  longRateLimitRetryAfter: string;
  timeoutRate: number;
  timeoutHangMs: number;
  duplicateItemsRate: number;
}

export interface FakeProviderOptions {
  clock: Clock;
  dataset?: DatasetOptions;
  pageSize?: number;
  /** Quando true, cada página repete o último post da anterior (post repetido entre páginas). */
  overlapPages?: boolean;
  chaos?: ChaosConfig | null;
  random?: () => number;
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

  app.get("/v1/:platform/accounts/:account/posts", async (c) => {
    const { platform, account } = c.req.param();
    count("requests");
    if (!PLATFORMS.has(platform)) return c.json({ error: "unknown_platform" }, 404);

    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token === "" || token === "revoked") {
      count("401");
      return c.json({ error: "invalid_token" }, 401);
    }

    const since = Date.parse(c.req.query("since") ?? "");
    const until = Date.parse(c.req.query("until") ?? "");
    if (Number.isNaN(since) || Number.isNaN(until)) return c.json({ error: "invalid_window" }, 400);

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

    const now = options.clock.now();
    const capturedAt = capturedAtFor(now);
    const visible = listPosts(platform, account, dataset)
      .filter((p) => p.publishedAt <= now.getTime() && p.publishedAt >= since && p.publishedAt < until)
      .sort((a, b) => b.publishedAt - a.publishedAt);

    const cursor = c.req.query("cursor");
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

    count("200");
    return c.json({
      data: items.map((p) => ({
        id: p.id,
        published_at: new Date(p.publishedAt).toISOString(),
        caption: p.caption,
        captured_at: new Date(capturedAt).toISOString(),
        metrics: metricsAt(platform, account, p, capturedAt),
      })),
      next_cursor: nextCursor,
    });
  });

  // Endpoints de controle, só existem no simulado.
  app.post("/__admin/faults", async (c) => {
    const body = (await c.req.json()) as { platform: string; account: string; faults: Fault[] };
    const key = `${body.platform}/${body.account}`;
    faults.set(key, [...(faults.get(key) ?? []), ...body.faults]);
    return c.json({ queued: faults.get(key)!.length });
  });

  app.put("/__admin/chaos", async (c) => {
    const body = (await c.req.json()) as ChaosConfig | { enabled: false };
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
