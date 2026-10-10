import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

describe("runs presos em running", () => {
  it("ao iniciar um sync, um run running mais velho que o limite vira failed/abandonado", async () => {
    const h = createHarness({ policy: { staleRunMs: 15 * 60 * 1000 } });
    const conn = await h.connect();
    const other = await h.connect({ external_account_id: "conta-b" });
    insertRunning(h, "velho", conn.id, "2026-10-01T09:00:00.000Z"); // 1h15 antes
    insertRunning(h, "outra-conexao", other.id, "2026-10-01T09:00:00.000Z");

    const res = await h.sync(conn.id);
    expect(res.status).toBe(201);

    expect(status(h, "velho")).toEqual({ status: "failed", error_code: "abandonado", finished_at: "2026-10-01T10:15:00.000Z" });
    expect(status(h, "outra-conexao")).toMatchObject({ status: "running" });
  });

  it("run running recente (pode estar vivo) bloqueia o novo sync com 409 e continua intacto", async () => {
    const h = createHarness({ policy: { staleRunMs: 15 * 60 * 1000 } });
    const conn = await h.connect();
    insertRunning(h, "recente", conn.id, "2026-10-01T10:05:00.000Z"); // 10 min antes

    const res = await h.sync(conn.id);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "sync_em_andamento" }, running_sync_run_id: "recente" });
    expect(status(h, "recente")).toEqual({ status: "running", error_code: null, finished_at: null });
    expect(h.providerRequests).toBe(0);
  });
});

function insertRunning(h: ReturnType<typeof createHarness>, id: string, connectionId: string, startedAt: string) {
  h.db
    .prepare(
      `INSERT INTO sync_runs (id, connection_id, window_since, window_until, status, started_at)
       VALUES (?, ?, '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', 'running', ?)`,
    )
    .run(id, connectionId, startedAt);
}

function status(h: ReturnType<typeof createHarness>, id: string) {
  return h.db.prepare("SELECT status, error_code, finished_at FROM sync_runs WHERE id = ?").get(id);
}

describe("retomada depois de rate_limited", () => {
  it("o próximo sync da mesma janela continua do cursor em que o anterior parou", async () => {
    const h = createHarness({ policy: { maxRetryAfterMs: 10_000 } });
    const conn = await h.connect();
    await h.faults("instagram", "conta-a", [{ type: "ok" }, { type: "status", status: 429, retry_after: "120" }]);

    const first = await h.sync(conn.id);
    expect(first.body.sync_run).toMatchObject({ status: "rate_limited", pages: 1, snapshots_inserted: 10 });
    expect(first.body.sync_run.resume_cursor).toEqual(expect.any(String));

    h.clock.advance(121_000);
    const callsBefore = h.providerRequests;
    const second = await h.sync(conn.id);

    // Retoma na página 2: 3 chamadas (páginas 2, 3 e 4) em vez de 4, e completa os 30 posts.
    expect(second.body.sync_run).toMatchObject({ status: "succeeded", resumed_from: first.body.sync_run.id, pages: 3, snapshots_inserted: 20 });
    expect(h.providerRequests - callsBefore).toBe(3);
    expect(h.snapshotCount()).toBe(30);
    expect(second.body.sync_run.resume_cursor).toBeNull();

    // O terceiro sync da mesma janela começa do zero, porque o último terminou bem.
    const third = await h.sync(conn.id);
    expect(third.body.sync_run).toMatchObject({ resumed_from: null, pages: 4 });
  });

  it("janela diferente não herda o cursor", async () => {
    const h = createHarness({ policy: { maxRetryAfterMs: 10_000 } });
    const conn = await h.connect();
    await h.faults("instagram", "conta-a", [{ type: "ok" }, { type: "status", status: 429, retry_after: "120" }]);
    await h.sync(conn.id);
    h.clock.advance(121_000);

    const other = await h.sync(conn.id, { since: "2026-09-01T00:00:00Z", until: "2026-09-05T00:00:00Z" });

    expect(other.body.sync_run).toMatchObject({ status: "succeeded", resumed_from: null });
  });

  it("rate_limited na primeira página não deixa cursor (não há de onde continuar)", async () => {
    const h = createHarness({ policy: { maxRetryAfterMs: 10_000 } });
    const conn = await h.connect();
    await h.faults("instagram", "conta-a", [{ type: "status", status: 429, retry_after: "120" }]);
    const res = await h.sync(conn.id);
    expect(res.body.sync_run).toMatchObject({ status: "rate_limited", resume_cursor: null });
  });
});
