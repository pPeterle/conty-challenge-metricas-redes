import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

describe("runs presos em running", () => {
  it("ao iniciar um sync, runs running da mesma conexão mais velhos que o limite viram failed/abandonado", async () => {
    const h = createHarness({ policy: { staleRunMs: 15 * 60 * 1000 } });
    const conn = await h.connect();
    const other = await h.connect({ external_account_id: "conta-b" });
    const insert = h.db.prepare(
      `INSERT INTO sync_runs (id, connection_id, window_since, window_until, status, started_at)
       VALUES (?, ?, '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', 'running', ?)`,
    );
    insert.run("velho", conn.id, "2026-10-01T09:00:00.000Z"); // 1h15 antes
    insert.run("recente", conn.id, "2026-10-01T10:05:00.000Z"); // 10 min antes: pode estar vivo
    insert.run("outra-conexao", other.id, "2026-10-01T09:00:00.000Z");

    const res = await h.sync(conn.id);
    expect(res.status).toBe(201);

    const status = (id: string) => h.db.prepare("SELECT status, error_code, finished_at FROM sync_runs WHERE id = ?").get(id);
    expect(status("velho")).toEqual({ status: "failed", error_code: "abandonado", finished_at: "2026-10-01T10:15:00.000Z" });
    expect(status("recente")).toEqual({ status: "running", error_code: null, finished_at: null });
    expect(status("outra-conexao")).toMatchObject({ status: "running" });
  });
});
