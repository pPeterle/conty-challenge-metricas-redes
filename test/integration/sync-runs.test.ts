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
