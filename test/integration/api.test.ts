import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

describe("conexões", () => {
  it("cria conexão já autorizada sem devolver o token", async () => {
    const h = createHarness();
    const res = await h.json("POST", "/connections", {
      creator_id: "criadora-1",
      platform: "tiktok",
      external_account_id: "conta-b",
      access_token: "token-fake",
    });

    expect(res.status).toBe(201);
    expect(res.body.connection).toMatchObject({ creator_id: "criadora-1", platform: "tiktok", rate_limited_until: null });
    expect(JSON.stringify(res.body)).not.toContain("token-fake");
  });

  it("a mesma conta conectada de novo responde 409 com a conexão existente", async () => {
    const h = createHarness();
    const first = await h.connect();
    const again = await h.json("POST", "/connections", {
      creator_id: "criadora-1",
      platform: "instagram",
      external_account_id: "conta-a",
      access_token: "outro",
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("connection_exists");
    expect(again.body.connection.id).toBe(first.id);
  });

  it("valida a entrada com mensagens claras", async () => {
    const h = createHarness();
    const bad = await h.json("POST", "/connections", { creator_id: "c", platform: "orkut", external_account_id: "x", access_token: "t" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toEqual({ code: "validation_error", message: "platform deve ser um de: instagram, tiktok, youtube, x" });

    const conn = await h.connect();
    const badWindow = await h.json("POST", `/connections/${conn.id}/sync`, { since: "2026-09-05T00:00:00Z", until: "2026-09-01T00:00:00Z" });
    expect(badWindow.status).toBe(400);
    expect(badWindow.body.error.message).toBe("since precisa ser anterior a until");

    const missing = await h.json("POST", "/connections/nao-existe/sync", { since: "2026-09-01T00:00:00Z", until: "2026-09-02T00:00:00Z" });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("connection_not_found");
  });
});

describe("totais do criador", () => {
  it("somam o snapshot mais recente de cada post em todas as plataformas", async () => {
    const h = createHarness();
    const expectedByPlatform = new Map<string, { posts: number; views: number; likes: number; comments: number }>();
    const ids = new Map<string, string>();
    for (const platform of ["instagram", "tiktok", "youtube", "x"]) {
      const conn = await h.connect({ platform, external_account_id: `conta-${platform}` });
      ids.set(platform, conn.id);
      await h.sync(conn.id);
      const e = await h.expected(platform, `conta-${platform}`);
      expectedByPlatform.set(platform, { posts: e.posts.length, ...e.totals });
    }

    // Uma hora depois só o Instagram sincroniza de novo: ganha um segundo snapshot por post,
    // e o total dele passa a ser o da medição nova (não a soma das duas).
    h.clock.advance(60 * 60 * 1000);
    await h.sync(ids.get("instagram")!);
    const ig = await h.expected("instagram", "conta-instagram");
    expectedByPlatform.set("instagram", { posts: ig.posts.length, ...ig.totals });

    const res = await h.json("GET", "/creators/criadora-1/metrics");

    const expected = { posts: 0, views: 0, likes: 0, comments: 0 };
    for (const e of expectedByPlatform.values()) {
      expected.posts += e.posts;
      expected.views += e.views;
      expected.likes += e.likes;
      expected.comments += e.comments;
    }
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual(expected);
    expect(res.body.by_platform).toEqual(
      ["instagram", "tiktok", "x", "youtube"].map((platform) => ({
        platform,
        ...expectedByPlatform.get(platform),
        last_fetched_at: platform === "instagram" ? "2026-10-01T11:15:00.000Z" : "2026-10-01T10:15:00.000Z",
      })),
    );
    expect(res.body.last_fetched_at).toBe("2026-10-01T11:15:00.000Z");
  });

  it("criador sem conexão responde 404", async () => {
    const h = createHarness();
    const res = await h.json("GET", "/creators/ninguem/metrics");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("creator_not_found");
  });
});
