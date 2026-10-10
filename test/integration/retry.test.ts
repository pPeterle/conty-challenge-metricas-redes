import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

const S = 1_000;

describe("falha transitória", () => {
  it("503 é repetido com backoff exponencial e o sync termina bem", async () => {
    const h = createHarness();
    const conn = await h.connect();
    await h.faults("instagram", "conta-a", [{ type: "status", status: 503 }, { type: "status", status: 500 }]);

    const res = await h.sync(conn.id);

    expect(res.status).toBe(201);
    expect(res.body.sync_run).toMatchObject({ status: "succeeded", attempts: 6, snapshots_inserted: 30 });
    expect(h.clock.sleeps).toEqual([100, 200]);
    const detail = await h.json("GET", `/sync-runs/${res.body.sync_run.id}`);
    expect(detail.body.attempts.slice(0, 3)).toMatchObject([
      { page: 1, attempt: 1, outcome: "transient", http_status: 503, wait_ms: 100 },
      { page: 1, attempt: 2, outcome: "transient", http_status: 500, wait_ms: 200 },
      { page: 1, attempt: 3, outcome: "ok", http_status: 200, wait_ms: 0 },
    ]);
  });

  it("falha transitória persistente para no teto de tentativas, sem loop infinito", async () => {
    const h = createHarness({ policy: { maxAttempts: 4 } });
    const conn = await h.connect();
    await h.faults("instagram", "conta-a", Array(50).fill({ type: "status", status: 503 }));

    const res = await h.sync(conn.id);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("provider_unavailable");
    expect(res.body.sync_run).toMatchObject({ status: "failed", attempts: 4, error_code: "provider_unavailable" });
    expect(h.providerRequests).toBe(4);
    expect(h.clock.sleeps).toEqual([100, 200, 400]);
    expect(res.body.sync_run.finished_at).not.toBeNull();
  });

  it("timeout do provedor é abortado pelo AbortController e repetido", async () => {
    const h = createHarness({ timeoutMs: 30 });
    const conn = await h.connect();
    await h.faults("instagram", "conta-a", [{ type: "timeout", hang_ms: 2_000 }]);

    const res = await h.sync(conn.id);

    expect(res.body.sync_run).toMatchObject({ status: "succeeded", snapshots_inserted: 30 });
    const detail = await h.json("GET", `/sync-runs/${res.body.sync_run.id}`);
    expect(detail.body.attempts[0]).toMatchObject({ outcome: "transient", http_status: null, detail: "timeout após 30ms" });
  });

  it("erro 4xx (token revogado) não é repetido", async () => {
    const h = createHarness();
    const conn = await h.connect({ access_token: "revoked" });

    const res = await h.sync(conn.id);

    expect(res.status).toBe(502);
    expect(res.body.sync_run).toMatchObject({ status: "failed", attempts: 1, error_code: "provider_rejected" });
    expect(h.providerRequests).toBe(1);
    expect(h.clock.sleeps).toEqual([]);
  });

  it("falha na segunda página preserva o que já foi gravado e um novo sync completa sem duplicar", async () => {
    const h = createHarness();
    const conn = await h.connect();
    await h.faults("instagram", "conta-a", [{ type: "ok" }, { type: "status", status: 403 }]);

    const first = await h.sync(conn.id);
    expect(first.body.sync_run).toMatchObject({ status: "failed", pages: 1, snapshots_inserted: 10 });

    const second = await h.sync(conn.id);
    expect(second.body.sync_run).toMatchObject({ status: "succeeded", snapshots_inserted: 20 });
    expect(h.snapshotCount()).toBe(30);
  });

  it("cursor repetido pelo provedor encerra o sync em vez de paginar para sempre", async () => {
    const h = createHarness();
    const conn = await h.connect();
    await h.faults("instagram", "conta-a", [{ type: "ok" }, { type: "cursor_loop" }]);

    const res = await h.sync(conn.id);

    expect(res.status).toBe(502);
    expect(res.body.sync_run).toMatchObject({ status: "failed", error_code: "provider_cursor_loop", pages: 2 });
  });
});

describe("429 e Retry-After", () => {
  it("429 com Retry-After em segundos espera exatamente esse prazo no relógio controlado", async () => {
    const h = createHarness();
    const conn = await h.connect();
    await h.faults("instagram", "conta-a", [{ type: "status", status: 429, retry_after: "3" }]);

    const res = await h.sync(conn.id);

    expect(res.status).toBe(201);
    expect(h.clock.sleeps).toEqual([3 * S]);
    const run = res.body.sync_run;
    expect(run).toMatchObject({ status: "succeeded", started_at: "2026-10-01T10:15:00.000Z", finished_at: "2026-10-01T10:15:03.000Z" });
    const detail = await h.json("GET", `/sync-runs/${run.id}`);
    expect(detail.body.attempts[0]).toMatchObject({ outcome: "rate_limited", http_status: 429, wait_ms: 3 * S });
    expect(detail.body.attempts[1]).toMatchObject({ outcome: "ok", at: "2026-10-01T10:15:03.000Z" });
  });

  it("429 com Retry-After em HTTP-date espera até a data pedida", async () => {
    const h = createHarness();
    const conn = await h.connect();
    const at = new Date(h.clock.now().getTime() + 7 * S).toUTCString();
    await h.faults("instagram", "conta-a", [{ type: "status", status: 429, retry_after: at }]);

    await h.sync(conn.id);

    expect(h.clock.sleeps).toEqual([7 * S]);
  });

  it("Retry-After acima do teto configurado para o sync com rate_limited e retry_at, sem esperar", async () => {
    const h = createHarness({ policy: { maxRetryAfterMs: 10 * S } });
    const conn = await h.connect();
    await h.faults("instagram", "conta-a", [{ type: "status", status: 429, retry_after: "120" }]);

    const res = await h.sync(conn.id);

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("120");
    expect(res.body.error.code).toBe("provider_rate_limited");
    expect(res.body.retry_at).toBe("2026-10-01T10:17:00.000Z");
    expect(res.body.sync_run).toMatchObject({ status: "rate_limited", attempts: 1, retry_at: "2026-10-01T10:17:00.000Z" });
    expect(h.clock.sleeps).toEqual([]);
  });

  it("enquanto o retry_at não passa, novo sync responde 503 sem chamar o provedor", async () => {
    const h = createHarness({ policy: { maxRetryAfterMs: 10 * S } });
    const conn = await h.connect();
    await h.faults("instagram", "conta-a", [{ type: "status", status: 429, retry_after: "120" }]);
    await h.sync(conn.id);
    const callsAfterFirst = h.providerRequests;

    h.clock.advance(60 * S);
    const blocked = await h.sync(conn.id);
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(blocked.body.retry_at).toBe("2026-10-01T10:17:00.000Z");
    expect(h.providerRequests).toBe(callsAfterFirst);

    h.clock.advance(60 * S);
    const ok = await h.sync(conn.id);
    expect(ok.status).toBe(201);
  });

  it("429 repetido também respeita o teto de tentativas", async () => {
    const h = createHarness({ policy: { maxAttempts: 4 } });
    const conn = await h.connect();
    await h.faults("instagram", "conta-a", Array(10).fill({ type: "status", status: 429, retry_after: "1" }));

    const res = await h.sync(conn.id);

    expect(res.status).toBe(503);
    expect(res.body.sync_run).toMatchObject({ status: "rate_limited", attempts: 4 });
    expect(h.clock.sleeps).toEqual([S, S, S]);
    expect(h.providerRequests).toBe(4);
  });

  it("429 sem Retry-After cai no backoff exponencial", async () => {
    const h = createHarness();
    const conn = await h.connect();
    await h.faults("instagram", "conta-a", [{ type: "status", status: 429 }, { type: "status", status: 429 }]);

    await h.sync(conn.id);

    expect(h.clock.sleeps).toEqual([100, 200]);
  });
});
