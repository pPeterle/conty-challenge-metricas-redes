import { describe, expect, it } from "vitest";
import { createHarness, FULL } from "./harness.ts";

describe("idempotência do sync", () => {
  it("post repetido entre páginas do provedor vira um único snapshot", async () => {
    const h = createHarness();
    const conn = await h.connect();

    const res = await h.sync(conn.id);

    expect(res.status).toBe(201);
    // 30 posts em páginas de 10, cada página repetindo o último post da anterior: 4 páginas, 33 itens.
    expect(res.body.sync_run).toMatchObject({
      status: "succeeded",
      pages: 4,
      items_received: 33,
      snapshots_inserted: 30,
      snapshots_duplicated: 3,
      attempts: 4,
    });
    expect(h.snapshotCount()).toBe(30);
  });

  it("a mesma resposta chegando duas vezes não duplica nem soma", async () => {
    const h = createHarness();
    const conn = await h.connect();

    await h.sync(conn.id);
    const second = await h.sync(conn.id);

    expect(second.body.sync_run).toMatchObject({ status: "succeeded", snapshots_inserted: 0, snapshots_duplicated: 33 });
    expect(h.snapshotCount()).toBe(30);
    const metrics = await h.json("GET", `/connections/${conn.id}/metrics`);
    const expected = await h.expected("instagram", "conta-a");
    expect(metrics.body.totals).toEqual({ posts: 30, ...expected.totals });
  });

  it("janelas sobrepostas não contam o mesmo post duas vezes", async () => {
    const h = createHarness();
    const conn = await h.connect();

    const a = await h.sync(conn.id, { since: "2026-09-01T00:00:00Z", until: "2026-09-05T00:00:00Z" });
    const b = await h.sync(conn.id, { since: "2026-09-03T00:00:00Z", until: "2026-09-09T00:00:00Z" });

    // A janela A tem 16 posts; B tem 22, dos quais 8 já vieram em A.
    expect(a.body.sync_run.snapshots_inserted).toBe(16);
    expect(b.body.sync_run.snapshots_inserted).toBe(14);
    expect(h.snapshotCount()).toBe(30);
    const metrics = await h.json("GET", `/connections/${conn.id}/metrics`);
    const expected = await h.expected("instagram", "conta-a");
    expect(metrics.body.totals).toEqual({ posts: 30, ...expected.totals });
  });

  it("provedor que manda o mesmo item duas vezes na página não duplica", async () => {
    const h = createHarness();
    const conn = await h.connect();
    await h.faults("instagram", "conta-a", [{ type: "duplicate_items" }, { type: "duplicate_items" }]);

    const res = await h.sync(conn.id);

    expect(res.body.sync_run).toMatchObject({ status: "succeeded", items_received: 53, snapshots_inserted: 30 });
    expect(h.snapshotCount()).toBe(30);
  });

  it("nova medição do provedor vira novo snapshot e o total usa só a mais recente, sem somar", async () => {
    const h = createHarness();
    const conn = await h.connect();
    await h.sync(conn.id);
    const before = await h.expected("instagram", "conta-a");

    h.clock.advance(60 * 60 * 1000); // o provedor mede de novo na hora seguinte
    await h.sync(conn.id);
    const after = await h.expected("instagram", "conta-a");

    expect(after.totals.views).toBeGreaterThan(before.totals.views);
    expect(h.snapshotCount()).toBe(60);
    const metrics = await h.json("GET", `/connections/${conn.id}/metrics`);
    expect(metrics.body.totals).toEqual({ posts: 30, ...after.totals });

    const postId = after.posts[0]!.id;
    const history = await h.json("GET", `/connections/${conn.id}/posts/${postId}/snapshots`);
    expect(history.body.snapshots.map((s: any) => s.captured_at)).toEqual([
      "2026-10-01T11:00:00.000Z",
      "2026-10-01T10:00:00.000Z",
    ]);
  });

  it("snapshot antigo que chega depois entra no histórico mas não vira a métrica atual", async () => {
    const h = createHarness();
    const conn = await h.connect();
    h.clock.set("2026-10-01T11:15:00Z");
    await h.sync(conn.id);
    const current = await h.expected("instagram", "conta-a");

    // Simula o provedor devolvendo um cache velho (medição das 10h) depois da das 11h.
    h.clock.set("2026-10-01T10:15:00Z");
    const stale = await h.sync(conn.id);
    h.clock.set("2026-10-01T11:20:00Z");

    expect(stale.body.sync_run.snapshots_inserted).toBe(30);
    const metrics = await h.json("GET", `/connections/${conn.id}/metrics`);
    expect(metrics.body.totals).toEqual({ posts: 30, ...current.totals });
    const posts = await h.json("GET", `/connections/${conn.id}/posts`);
    expect(new Set(posts.body.posts.map((p: any) => p.captured_at))).toEqual(new Set(["2026-10-01T11:00:00.000Z"]));
  });

  it("syncs concorrentes da mesma conexão: um roda, os outros recebem 409 sync_em_andamento, e nada duplica", async () => {
    const h = createHarness();
    const conn = await h.connect();
    const windows = [
      FULL,
      { since: "2026-09-01T00:00:00Z", until: "2026-09-04T00:00:00Z" },
      { since: "2026-09-02T00:00:00Z", until: "2026-09-06T00:00:00Z" },
      { since: "2026-09-05T00:00:00Z", until: "2026-09-09T00:00:00Z" },
      FULL,
    ];

    const results = await Promise.all([...windows, ...windows].map((w) => h.sync(conn.id, w)));

    expect(results.map((r) => r.status)).toEqual([201, ...Array(9).fill(409)]);
    for (const r of results.slice(1)) {
      expect(r.body.error.code).toBe("sync_em_andamento");
      expect(r.body.running_sync_run_id).toBe(results[0]!.body.sync_run.id);
    }
    expect(results[0]!.body.sync_run.snapshots_inserted).toBe(30);

    // Depois que o primeiro termina, as mesmas janelas sobrepostas rodam de novo sem gravar nada.
    for (const w of windows) {
      const again = await h.sync(conn.id, w);
      expect(again.status).toBe(201);
      expect(again.body.sync_run.snapshots_inserted).toBe(0);
    }
    expect(h.snapshotCount()).toBe(30);
    const perPost = h.db
      .prepare("SELECT MAX(n) AS max FROM (SELECT COUNT(*) AS n FROM metric_snapshots GROUP BY external_post_id)")
      .get() as { max: number };
    expect(perPost.max).toBe(1);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM sync_runs WHERE status = 'running'").get()).toEqual({ n: 0 });
    const metrics = await h.json("GET", `/connections/${conn.id}/metrics`);
    expect(metrics.body.totals).toEqual({ posts: 30, ...(await h.expected("instagram", "conta-a")).totals });
  });

  it("conexões diferentes sincronizam em paralelo normalmente", async () => {
    const h = createHarness();
    const conns = await Promise.all(["a", "b", "c"].map((x) => h.connect({ external_account_id: `conta-${x}` })));
    const results = await Promise.all(conns.map((c) => h.sync(c.id)));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(h.snapshotCount()).toBe(90);
  });
});

describe("quando a métrica foi buscada", () => {
  it("cada post mostra captured_at (medição do provedor), fetched_at (nossa busca) e last_fetched_at", async () => {
    const h = createHarness();
    const conn = await h.connect();
    await h.sync(conn.id);

    h.clock.advance(10 * 60 * 1000); // 10:25, mesma hora: o provedor devolve a mesma medição
    await h.sync(conn.id);

    const posts = await h.json("GET", `/connections/${conn.id}/posts`);
    expect(posts.body.posts).toHaveLength(30);
    expect(posts.body.posts[0]).toMatchObject({
      captured_at: "2026-10-01T10:00:00.000Z",
      fetched_at: "2026-10-01T10:15:00.000Z",
      last_fetched_at: "2026-10-01T10:25:00.000Z",
      snapshots: 1,
    });
    const metrics = await h.json("GET", `/connections/${conn.id}/metrics`);
    expect(metrics.body.last_fetched_at).toBe("2026-10-01T10:25:00.000Z");

    const runs = await h.json("GET", `/connections/${conn.id}/sync-runs`);
    expect(runs.body.sync_runs.map((r: any) => r.started_at)).toEqual([
      "2026-10-01T10:25:00.000Z",
      "2026-10-01T10:15:00.000Z",
    ]);
  });
});

describe("mesmo captured_at com números diferentes", () => {
  it("vale o primeiro e o conflito fica registrado no run", async () => {
    const h = createHarness();
    const conn = await h.connect();
    await h.sync(conn.id);
    const before = await h.json("GET", `/connections/${conn.id}/metrics`);
    await h.faults("instagram", "conta-a", [{ type: "metrics_offset", views: 500 }]);

    const res = await h.sync(conn.id);

    // A página 1 (10 posts) voltou com a mesma medição e 500 views a mais.
    expect(res.body.sync_run).toMatchObject({ status: "succeeded", snapshots_inserted: 0, snapshot_conflicts: 10 });
    expect(h.snapshotCount()).toBe(30);
    const after = await h.json("GET", `/connections/${conn.id}/metrics`);
    expect(after.body.totals).toEqual(before.body.totals);
    const detail = await h.json("GET", `/sync-runs/${res.body.sync_run.id}`);
    const conflict = detail.body.anomalies.find((a: any) => a.external_post_id === "instagram-conta-a-p030");
    expect(conflict.kind).toBe("snapshot_conflitante");
    expect(conflict.detail).toMatch(/^captured_at=2026-10-01T10:00:00.000Z gravado=\{"views":(\d+),.*\} recebido=\{"views":(\d+),/);
  });

  it("reenvio idêntico não conta como conflito", async () => {
    const h = createHarness();
    const conn = await h.connect();
    await h.sync(conn.id);
    const res = await h.sync(conn.id);
    expect(res.body.sync_run).toMatchObject({ snapshots_duplicated: 33, snapshot_conflicts: 0 });
  });
});
