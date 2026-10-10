import pino from "pino";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

const JSON_TYPE = { "content-type": "application/json" };
const validConnection = {
  creator_id: "criadora-1",
  platform: "instagram",
  external_account_id: "conta-a",
  access_token: "token-fake",
};

type Case = [name: string, init: { body?: string; headers?: Record<string, string> }, status: number];

const raw = (body: string): [{ body: string; headers: Record<string, string> }, number] => [{ body, headers: JSON_TYPE }, 400];

/** Casos que valem para qualquer endpoint que recebe corpo JSON. */
const bodyShapeCases: Case[] = [
  ["JSON malformado", ...raw("{ creator_id: ")],
  ["corpo vazio", ...raw("")],
  ["só espaços", ...raw("   ")],
  ["null", ...raw("null")],
  ["array no lugar de objeto", ...raw("[]")],
  ["string solta", ...raw('"oi"')],
  ["número solto", ...raw("42")],
  ["sem content-type", { body: JSON.stringify(validConnection) }, 415],
  ["content-type text/plain", { body: JSON.stringify(validConnection), headers: { "content-type": "text/plain" } }, 415],
  ["corpo acima de 16 KB", { body: JSON.stringify({ ...validConnection, x: "a".repeat(20_000) }), headers: JSON_TYPE }, 413],
];

const connectionFieldCases: Array<[string, Record<string, unknown>]> = [
  ["sem creator_id", { ...validConnection, creator_id: undefined }],
  ["creator_id número", { ...validConnection, creator_id: 123 }],
  ["creator_id vazio", { ...validConnection, creator_id: "" }],
  ["creator_id com espaço", { ...validConnection, creator_id: "ana maria" }],
  ["creator_id com unicode", { ...validConnection, creator_id: "ação😀" }],
  ["creator_id gigante", { ...validConnection, creator_id: "a".repeat(129) }],
  ["platform desconhecida", { ...validConnection, platform: "orkut" }],
  ["platform em maiúsculas", { ...validConnection, platform: "Instagram" }],
  ["platform array", { ...validConnection, platform: ["instagram"] }],
  ["external_account_id objeto", { ...validConnection, external_account_id: { id: "x" } }],
  ["external_account_id com barra", { ...validConnection, external_account_id: "../admin" }],
  ["access_token só espaços", { ...validConnection, access_token: "   " }],
  ["access_token número", { ...validConnection, access_token: 1 }],
  ["access_token gigante", { ...validConnection, access_token: "t".repeat(5_000) }],
];

const windowCases: Array<[string, unknown]> = [
  ["sem since", { until: "2026-09-02T00:00:00Z" }],
  ["sem until", { since: "2026-09-01T00:00:00Z" }],
  ["since número", { since: 1_700_000_000, until: "2026-09-02T00:00:00Z" }],
  ["since sem fuso", { since: "2026-09-01T00:00:00", until: "2026-09-02T00:00:00Z" }],
  ["since só data", { since: "2026-09-01", until: "2026-09-02T00:00:00Z" }],
  ["data inexistente (30/02)", { since: "2026-02-30T00:00:00Z", until: "2026-03-05T00:00:00Z" }],
  ["mês 13", { since: "2026-13-01T00:00:00Z", until: "2026-12-05T00:00:00Z" }],
  ["hora 25", { since: "2026-09-01T25:00:00Z", until: "2026-09-02T00:00:00Z" }],
  ["fuso +24:00", { since: "2026-09-01T00:00:00+24:00", until: "2026-09-02T00:00:00Z" }],
  ["fuso +99:00", { since: "2026-09-01T00:00:00+99:00", until: "2026-09-02T00:00:00Z" }],
  ["fuso +23:60", { since: "2026-09-01T00:00:00Z", until: "2026-09-02T00:00:00+23:60" }],
  ["fuso -15:00", { since: "2026-09-01T00:00:00-15:00", until: "2026-09-02T00:00:00Z" }],
  ["texto livre", { since: "ontem", until: "hoje" }],
  ["NaN serializado vira null", { since: null, until: "2026-09-02T00:00:00Z" }],
  ["since igual a until", { since: "2026-09-01T00:00:00Z", until: "2026-09-01T00:00:00Z" }],
  ["janela invertida", { since: "2026-09-05T00:00:00Z", until: "2026-09-01T00:00:00Z" }],
  ["janela de um ano", { since: "2025-09-01T00:00:00Z", until: "2026-09-01T00:00:00Z" }],
  ["since objeto", { since: { $gt: "" }, until: "2026-09-02T00:00:00Z" }],
];

function counts(h: ReturnType<typeof createHarness>) {
  const n = (table: string) => (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    connections: n("connections"),
    posts: n("posts"),
    snapshots: n("metric_snapshots"),
    runs: n("sync_runs"),
    attempts: n("sync_attempts"),
  };
}

function expectError(res: { status: number; body: any }, status: number) {
  expect(res.status).toBe(status);
  expect(Object.keys(res.body)).toEqual(["error"]);
  expect(res.body.error).toMatchObject({ code: expect.any(String), message: expect.any(String) });
  for (const key of Object.keys(res.body.error)) expect(["code", "message", "details"]).toContain(key);
  if (res.body.error.details) {
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([{ path: expect.any(String), message: expect.any(String) }]),
    );
  }
}

async function send(h: ReturnType<typeof createHarness>, path: string, init: { body?: string; headers?: Record<string, string> }) {
  const res = await h.app.request(path, { method: "POST", ...init });
  return { status: res.status, body: (await res.json()) as any };
}

describe("payloads inválidos em POST /connections", () => {
  it.each(bodyShapeCases)("%s responde 4xx com o erro padrão", async (_name, init, status) => {
    const h = createHarness();
    expectError(await send(h, "/connections", init), status);
  });

  it.each(connectionFieldCases)("%s responde 400", async (_name, body) => {
    const h = createHarness();
    const res = await h.json("POST", "/connections", body);
    expectError(res, 400);
    expect(res.body.error.code).toBe("validation_error");
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it("campos extras desconhecidos são ignorados", async () => {
    const h = createHarness();
    const res = await h.json("POST", "/connections", { ...validConnection, admin: true, extra: { a: 1 } });
    expect(res.status).toBe(201);
    expect(res.body.connection).not.toHaveProperty("admin");
  });
});

describe("payloads inválidos em POST /connections/:id/sync", () => {
  it.each(bodyShapeCases)("%s responde 4xx com o erro padrão", async (_name, init, status) => {
    const h = createHarness();
    const conn = await h.connect();
    expectError(await send(h, `/connections/${conn.id}/sync`, init), status);
  });

  it.each(windowCases)("%s responde 400", async (_name, body) => {
    const h = createHarness();
    const conn = await h.connect();
    const res = await h.json("POST", `/connections/${conn.id}/sync`, body);
    expectError(res, 400);
  });

  it("campos extras na janela são ignorados", async () => {
    const h = createHarness();
    const conn = await h.connect();
    const res = await h.json("POST", `/connections/${conn.id}/sync`, {
      since: "2026-09-01T00:00:00Z",
      until: "2026-09-02T00:00:00Z",
      force: true,
    });
    expect(res.status).toBe(201);
  });
});

describe("nada inválido grava no banco", () => {
  it("todos os payloads inválidos acima deixam o banco como estava e o provedor sem chamadas", async () => {
    const h = createHarness();
    const conn = await h.connect();
    const before = counts(h);

    for (const [, init] of bodyShapeCases) {
      await send(h, "/connections", init);
      await send(h, `/connections/${conn.id}/sync`, init);
    }
    for (const [, body] of connectionFieldCases) await h.json("POST", "/connections", body);
    for (const [, body] of windowCases) await h.json("POST", `/connections/${conn.id}/sync`, body);

    expect(counts(h)).toEqual(before);
    expect(h.providerRequests).toBe(0);
  });
});

describe("rotas, ids e listagens", () => {
  it.each([
    ["GET", "/nao-existe"],
    ["GET", "/connections/nao-existe"],
    ["GET", "/connections/%F0%9F%98%80"],
    ["GET", "/connections/nao-existe/posts"],
    ["GET", "/connections/nao-existe/metrics"],
    ["GET", "/sync-runs/nao-existe"],
    ["GET", "/creators/ningu%C3%A9m/metrics"],
    ["DELETE", "/connections"],
    ["PUT", "/connections/x/sync"],
  ])("%s %s responde 404 JSON", async (method, path) => {
    const h = createHarness();
    expectError(await h.json(method, path), 404);
  });

  it("post inexistente de uma conexão existente responde 404", async () => {
    const h = createHarness();
    const conn = await h.connect();
    expectError(await h.json("GET", `/connections/${conn.id}/posts/nao-existe/snapshots`), 404);
  });

  it.each(["limit=0", "limit=201", "limit=-1", "limit=abc", "limit=1.5", "offset=-1", "offset=x", "limit=1e2"])(
    "listagem com %s responde 400",
    async (query) => {
      const h = createHarness();
      const conn = await h.connect();
      for (const path of [`/connections/${conn.id}/posts`, `/connections/${conn.id}/sync-runs`]) {
        expectError(await h.json("GET", `${path}?${query}`), 400);
      }
    },
  );

  it("limit e offset paginam os posts", async () => {
    const h = createHarness();
    const conn = await h.connect();
    await h.sync(conn.id);

    const first = await h.json("GET", `/connections/${conn.id}/posts?limit=10`);
    const last = await h.json("GET", `/connections/${conn.id}/posts?limit=10&offset=25`);

    expect(first.body).toMatchObject({ limit: 10, offset: 0 });
    expect(first.body.posts).toHaveLength(10);
    expect(last.body.posts).toHaveLength(5);
    expect(last.body.posts[4].external_post_id).toBe("instagram-conta-a-p001");
  });

  it("erro inesperado vira 500 JSON genérico, sem stack trace, e o erro vai para o logger", async () => {
    const lines: string[] = [];
    const logger = pino({ level: "info" }, { write: (line: string) => void lines.push(line) });
    const h = createHarness({ logger });
    const conn = await h.connect();
    h.db.exec("DROP TABLE sync_attempts");
    const res = await h.sync(conn.id);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: "internal_error", message: "erro interno inesperado" } });
    const run = h.db.prepare("SELECT status, error_code FROM sync_runs").get();
    expect(run).toEqual({ status: "failed", error_code: "internal_error" });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ level: 50, msg: "erro inesperado", method: "POST", path: `/connections/${conn.id}/sync` });
    expect(entry.err.message).toMatch(/sync_attempts/);
    expect(lines[0]).not.toContain("token-fake");
  });

});
