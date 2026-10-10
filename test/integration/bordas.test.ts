import { describe, expect, it } from "vitest";
import type { PageRequest, ProviderClient, ProviderResponse } from "../../src/provider/types.ts";
import { createHarness, FULL } from "./harness.ts";

const count = (h: ReturnType<typeof createHarness>, table: string) =>
  (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("post fora da janela pedida", () => {
  it("é descartado e contado como anomalia no sync_run", async () => {
    const h = createHarness();
    const conn = await h.connect();
    await h.faults("instagram", "conta-a", [{ type: "out_of_window" }]);

    const res = await h.sync(conn.id);

    expect(res.body.sync_run).toMatchObject({ status: "succeeded", items_received: 34, items_out_of_window: 1, snapshots_inserted: 30 });
    expect(h.db.prepare("SELECT 1 FROM posts WHERE external_post_id = 'instagram-conta-a-fora'").get()).toBeUndefined();
    expect(count(h, "metric_snapshots")).toBe(30);
  });
});

describe("gravação atômica por página", () => {
  it("falha de gravação no meio da página desfaz a página inteira", async () => {
    const h = createHarness();
    const conn = await h.connect();
    // A primeira página traz p030..p021; o quinto post dela quebra o INSERT.
    h.db.exec(`CREATE TRIGGER quebra BEFORE INSERT ON metric_snapshots
      WHEN NEW.external_post_id = 'instagram-conta-a-p026'
      BEGIN SELECT RAISE(ABORT, 'falha simulada de disco'); END`);
    const res = await h.sync(conn.id);
    expect(res.status).toBe(500);

    expect(count(h, "posts")).toBe(0);
    expect(count(h, "metric_snapshots")).toBe(0);
    expect(h.db.prepare("SELECT status, error_code, pages, snapshots_inserted FROM sync_runs").get()).toEqual({
      status: "failed",
      error_code: "internal_error",
      pages: 0,
      snapshots_inserted: 0,
    });

    h.db.exec("DROP TRIGGER quebra");
    expect((await h.sync(conn.id)).body.sync_run.snapshots_inserted).toBe(30);
  });
});

describe("timeout", () => {
  it("resposta que chega depois do timeout não grava nada", async () => {
    const h = createHarness({ timeoutMs: 30, policy: { maxAttempts: 1 } });
    const conn = await h.connect();
    await h.faults("instagram", "conta-a", [{ type: "slow", delay_ms: 120 }]);

    const res = await h.sync(conn.id);
    expect(res.status).toBe(502);
    expect(res.body.sync_run).toMatchObject({ status: "failed", error_code: "provider_unavailable" });

    // Espera o provedor terminar de responder de verdade; nada pode aparecer no banco.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(count(h, "posts")).toBe(0);
    expect(count(h, "metric_snapshots")).toBe(0);
  });
});

describe("isolamento entre conexões", () => {
  it("o mesmo external_post_id em duas conexões/redes fica separado", async () => {
    // Provedor que devolve o mesmo id de post para qualquer conta, com números diferentes por rede.
    const provider: ProviderClient = {
      async fetchPostsPage(req: PageRequest): Promise<ProviderResponse> {
        const views = req.platform === "instagram" ? 100 : 7;
        return {
          kind: "ok",
          httpStatus: 200,
          page: {
            posts: [{ externalId: "post-1", publishedAt: "2026-09-01T00:00:00.000Z", caption: null, capturedAt: "2026-10-01T10:00:00.000Z", views, likes: 1, comments: 0 }],
            nextCursor: null,
          },
        };
      },
    };
    const h = createHarness({ provider });
    const ig = await h.connect({ platform: "instagram", external_account_id: "ana" });
    const tt = await h.connect({ platform: "tiktok", external_account_id: "ana" });

    expect((await h.sync(ig.id, FULL)).body.sync_run.snapshots_inserted).toBe(1);
    expect((await h.sync(tt.id, FULL)).body.sync_run.snapshots_inserted).toBe(1);

    const igMetrics = await h.json("GET", `/connections/${ig.id}/metrics`);
    const ttMetrics = await h.json("GET", `/connections/${tt.id}/metrics`);
    expect(igMetrics.body.totals).toMatchObject({ posts: 1, views: 100 });
    expect(ttMetrics.body.totals).toMatchObject({ posts: 1, views: 7 });
    expect((await h.json("GET", "/creators/criadora-1/metrics")).body.totals).toMatchObject({ posts: 2, views: 107 });
  });
});

describe("normalização da conta", () => {
  it.each(["@Ana.Cria", " ana.cria ", "ANA.CRIA", "@ana.cria"])("%s é a mesma conta que ana.cria", async (variant) => {
    const h = createHarness();
    const first = await h.connect({ external_account_id: "ana.cria" });
    const again = await h.json("POST", "/connections", {
      creator_id: "criadora-1",
      platform: "instagram",
      external_account_id: variant,
      access_token: "t",
    });
    expect(again.status).toBe(409);
    expect(again.body.connection).toMatchObject({ id: first.id, external_account_id: "ana.cria" });
  });
});

describe("datas estritas", () => {
  it.each([
    ["30 de fevereiro", "2026-02-30T00:00:00Z"],
    ["29 de fevereiro em ano não bissexto", "2026-02-29T00:00:00Z"],
    ["31 de abril", "2026-04-31T00:00:00Z"],
    ["hora 24", "2026-09-01T24:00:00Z"],
  ])("since com %s responde 400", async (_name, since) => {
    const h = createHarness();
    const conn = await h.connect();
    const res = await h.json("POST", `/connections/${conn.id}/sync`, { since, until: "2026-09-09T00:00:00Z" });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([
      { path: "since", message: "since deve ser uma data ISO 8601 válida com fuso (ex.: 2026-09-01T00:00:00Z)" },
    ]);
  });

  it("captured_at impossível vindo do provedor torna a página inválida (erro permanente, nada gravado)", async () => {
    const provider: ProviderClient = {
      async fetchPostsPage(): Promise<ProviderResponse> {
        const { parsePage } = await import("../../src/provider/http-client.ts");
        const page = parsePage({
          data: [{ id: "p", published_at: "2026-09-01T00:00:00Z", captured_at: "2026-02-30T10:00:00Z", metrics: { views: 1, likes: 0, comments: 0 } }],
          next_cursor: null,
        });
        return page ? { kind: "ok", httpStatus: 200, page } : { kind: "permanent", httpStatus: 200, reason: "resposta do provedor fora do contrato" };
      },
    };
    const h = createHarness({ provider });
    const conn = await h.connect();
    const res = await h.sync(conn.id);
    expect(res.status).toBe(502);
    expect(res.body.sync_run).toMatchObject({ status: "failed", error_code: "provider_rejected" });
    expect(count(h, "metric_snapshots")).toBe(0);
  });
});

describe("fuso impossível", () => {
  it.each(["+24:00", "+23:60", "-15:00"])("captured_at com fuso %s vindo do provedor é recusado como fora do contrato", async (offset) => {
    const h = createHarness();
    const conn = await h.connect();
    await h.faults("instagram", "conta-a", [{ type: "captured_at", value: `2026-10-01T10:00:00${offset}` }]);
    const res = await h.sync(conn.id);
    expect(res.status).toBe(502);
    expect(res.body.sync_run).toMatchObject({ status: "failed", error_code: "provider_rejected" });
    expect(count(h, "metric_snapshots")).toBe(0);
  });

  it.each(["+24:00", "+99:00", "-15:00"])("o provedor simulado recusa since com fuso %s em vez de devolver página vazia", async (offset) => {
    const { createFakeProviderApp } = await import("../../src/fake-provider/app.ts");
    const provider = createFakeProviderApp({ clock: { now: () => new Date("2026-10-01T10:00:00Z") } });
    const since = encodeURIComponent(`2026-09-01T00:00:00${offset}`);
    const res = await provider.request(`/v1/instagram/accounts/a/posts?since=${since}&until=2026-09-09T00:00:00Z`, {
      headers: { authorization: "Bearer x" },
    });
    expect(res.status).toBe(400);
  });
});

describe("captured_at no futuro", () => {
  it("medição datada muito à frente do relógio não vira a atual e as medições reais seguintes valem", async () => {
    const h = createHarness({ policy: { maxFutureSkewMs: 5 * 60 * 1000 } });
    const conn = await h.connect();
    await h.faults("instagram", "conta-a", [{ type: "captured_at", value: "2099-01-01T00:00:00Z" }]);

    const first = await h.sync(conn.id);

    // A primeira página (10 posts) veio com captured_at de 2099: nada dela é gravado. Entram os 20
    // posts das outras páginas mais o p021, que se repete no começo da página 2 com a medição real.
    expect(first.body.sync_run).toMatchObject({ status: "succeeded", items_captured_in_future: 10, snapshots_inserted: 21 });
    const detail = await h.json("GET", `/sync-runs/${first.body.sync_run.id}`);
    expect(detail.body.anomalies).toHaveLength(10);
    expect(detail.body.anomalies[0]).toMatchObject({ kind: "captured_at_no_futuro", detail: "captured_at=2099-01-01T00:00:00.000Z" });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM metric_snapshots WHERE captured_at > '2027'").get()).toEqual({ n: 0 });

    // Uma hora depois o provedor volta ao normal: a medição real é a atual de todos os posts.
    h.clock.advance(60 * 60 * 1000);
    await h.sync(conn.id);
    const metrics = await h.json("GET", `/connections/${conn.id}/metrics`);
    expect(metrics.body.totals).toEqual({ posts: 30, ...(await h.expected("instagram", "conta-a")).totals });
  });

  it("captured_at dentro da tolerância é aceito", async () => {
    const h = createHarness({ policy: { maxFutureSkewMs: 5 * 60 * 1000 } });
    const conn = await h.connect();
    // Relógio da API em 10:15; o provedor diz que mediu às 10:19, 4 min à frente.
    await h.faults("instagram", "conta-a", [{ type: "captured_at", value: "2026-10-01T10:19:00Z" }]);

    const res = await h.sync(conn.id);

    // 30 posts, mais o p021 repetido na página 2 com a medição das 10:00: outra medição, outro snapshot.
    expect(res.body.sync_run).toMatchObject({ items_captured_in_future: 0, snapshots_inserted: 31 });
  });
});
