import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

describe("token recusado pelo provedor", () => {
  it("401 marca a conexão como needs_reauth e os syncs seguintes respondem 409 sem chamar o provedor", async () => {
    const h = createHarness();
    const conn = await h.connect({ access_token: "revoked" });

    const first = await h.sync(conn.id);
    expect(first.status).toBe(502);
    expect(first.body.sync_run).toMatchObject({ status: "failed", error_code: "provider_unauthorized" });
    expect((await h.json("GET", `/connections/${conn.id}`)).body.connection.status).toBe("needs_reauth");

    const calls = h.providerRequests;
    const blocked = await h.sync(conn.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("reautorizacao_necessaria");
    expect(h.providerRequests).toBe(calls);
    expect((await h.json("GET", `/connections/${conn.id}/sync-runs`)).body.sync_runs).toHaveLength(1);
  });

  it("PUT do token reativa a conexão e o sync volta a funcionar", async () => {
    const h = createHarness();
    const conn = await h.connect({ access_token: "revoked" });
    await h.sync(conn.id);

    const put = await h.json("PUT", `/connections/${conn.id}/token`, { access_token: "token-novo" });
    expect(put.status).toBe(200);
    expect(put.body.connection).toMatchObject({ id: conn.id, status: "active" });
    expect(JSON.stringify(put.body)).not.toContain("token-novo");

    const ok = await h.sync(conn.id);
    expect(ok.status).toBe(201);
    expect(ok.body.sync_run.snapshots_inserted).toBe(30);
  });

  it("PUT do token valida o corpo e a conexão", async () => {
    const h = createHarness();
    const conn = await h.connect();
    expect((await h.json("PUT", `/connections/${conn.id}/token`, { access_token: "  " })).status).toBe(400);
    expect((await h.json("PUT", `/connections/${conn.id}/token`, {})).status).toBe(400);
    expect((await h.json("PUT", "/connections/nao-existe/token", { access_token: "t" })).status).toBe(404);
  });

  it("403 não marca needs_reauth (o token vale, falta permissão para aquele recurso)", async () => {
    const h = createHarness();
    const conn = await h.connect();
    await h.faults("instagram", "conta-a", [{ type: "status", status: 403 }]);
    await h.sync(conn.id);
    expect((await h.json("GET", `/connections/${conn.id}`)).body.connection.status).toBe("active");
  });
});
