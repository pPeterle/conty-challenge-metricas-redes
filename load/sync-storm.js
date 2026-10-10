// Muitos syncs concorrentes e com janelas sobrepostas contra o provedor simulado com falhas
// (5xx, 429 com Retry-After, timeout, itens duplicados, posts repetidos entre páginas).
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3102";
const PLATFORMS = ["instagram", "tiktok", "youtube", "x"];
const CONNECTIONS = 20;
const DAY = 24 * 3600 * 1000;
const DATASET_START = Date.parse("2026-09-01T00:00:00Z");

const syncSucceeded = new Counter("sync_201_succeeded");
const syncRateLimited = new Counter("sync_503_rate_limited");
const syncFailed = new Counter("sync_502_failed");
const syncBusy = new Counter("sync_409_em_andamento");
const syncSuccessRate = new Rate("sync_success_rate");

export const options = {
  scenarios: {
    syncs: { executor: "constant-vus", vus: 40, duration: "30s", exec: "syncStorm" },
    reads: { executor: "constant-vus", vus: 5, duration: "30s", exec: "readMetrics" },
  },
  thresholds: {
    checks: ["rate>0.99"],
    sync_success_rate: ["rate>0.9"],
    invalid_payload_rejected_4xx: ["rate==1"],
    // 201 = sync completo; 503 = parou por limite de taxa (comportamento esperado sob 429 longo).
    http_req_failed: ["rate<0.05"],
    "http_req_duration{scenario:syncs}": ["p(95)<5000"],
    "http_req_duration{scenario:reads}": ["p(95)<500"],
  },
};

// 4xx de payload inválido também é resposta esperada; 5xx nunca é.
// 409 = já há um sync da mesma conexão em andamento (um por vez, por desenho).
http.setResponseCallback(http.expectedStatuses(200, 201, 400, 404, 409, 413, 415, 503));

const invalidRejected = new Rate("invalid_payload_rejected_4xx");
const JSON_HEADERS = { "content-type": "application/json" };
const INVALID = [
  { path: "sync", body: "{ since: ", headers: JSON_HEADERS },
  { path: "sync", body: "", headers: JSON_HEADERS },
  { path: "sync", body: "null", headers: JSON_HEADERS },
  { path: "sync", body: "[1,2,3]", headers: JSON_HEADERS },
  { path: "sync", body: JSON.stringify({ since: "2026-02-30T00:00:00Z", until: "2026-03-05T00:00:00Z" }), headers: JSON_HEADERS },
  { path: "sync", body: JSON.stringify({ since: "2026-09-01T00:00:00", until: "2026-09-02T00:00:00Z" }), headers: JSON_HEADERS },
  { path: "sync", body: JSON.stringify({ since: 1, until: { a: 1 } }), headers: JSON_HEADERS },
  { path: "sync", body: JSON.stringify({ since: "2026-09-05T00:00:00Z", until: "2026-09-01T00:00:00Z" }), headers: JSON_HEADERS },
  { path: "sync", body: JSON.stringify({ since: "2026-09-01T00:00:00Z", until: "2026-09-02T00:00:00Z" }), headers: {} },
  { path: "sync", body: JSON.stringify({ since: "x".repeat(20000), until: "y" }), headers: JSON_HEADERS },
  { path: "unknown-sync", body: JSON.stringify({ since: "2026-09-01T00:00:00Z", until: "2026-09-02T00:00:00Z" }), headers: JSON_HEADERS },
  { path: "connections", body: JSON.stringify({ creator_id: "ação 😀", platform: "instagram", external_account_id: "a", access_token: "t" }), headers: JSON_HEADERS },
  { path: "connections", body: JSON.stringify({ creator_id: "c", platform: "orkut", external_account_id: "a", access_token: "t" }), headers: JSON_HEADERS },
  { path: "connections", body: JSON.stringify({ creator_id: "c", platform: "x", external_account_id: "a", access_token: "   " }), headers: JSON_HEADERS },
  { path: "connections", body: '"oi"', headers: { "content-type": "text/plain" } },
];

function sendInvalid(data) {
  const c = INVALID[Math.floor(Math.random() * INVALID.length)];
  const id = data.ids[Math.floor(Math.random() * data.ids.length)];
  const url = c.path === "connections"
    ? `${BASE_URL}/connections`
    : `${BASE_URL}/connections/${c.path === "sync" ? id : "nao-existe"}/sync`;
  const res = http.post(url, c.body, { headers: c.headers, tags: { name: "payload inválido" } });
  const ok = res.status >= 400 && res.status < 500;
  invalidRejected.add(ok);
  check(res, {
    "payload inválido recebe 4xx": () => ok,
    "erro no formato padrão": (r) => typeof r.json("error.code") === "string",
  });
}

export function setup() {
  const ids = [];
  for (let i = 0; i < CONNECTIONS; i++) {
    const platform = PLATFORMS[i % PLATFORMS.length];
    const res = http.post(
      `${BASE_URL}/connections`,
      JSON.stringify({
        creator_id: `criador-${i % 5}`,
        platform,
        external_account_id: `carga-${i}`,
        access_token: "token-fake",
      }),
      { headers: { "content-type": "application/json" } },
    );
    if (res.status !== 201) throw new Error(`setup falhou: ${res.status} ${res.body}`);
    ids.push(res.json("connection.id"));
  }
  return { ids };
}

function randomWindow() {
  // Janelas de 1 a 8 dias começando entre 01/09 e 08/09: quase sempre se sobrepõem.
  const startDay = Math.floor(Math.random() * 8);
  const length = 1 + Math.floor(Math.random() * 8);
  return {
    since: new Date(DATASET_START + startDay * DAY).toISOString(),
    until: new Date(DATASET_START + Math.min(startDay + length, 9) * DAY).toISOString(),
  };
}

export function syncStorm(data) {
  // 10% das iterações mandam lixo: tem que voltar 4xx e não pode gravar nada.
  if (Math.random() < 0.1) return sendInvalid(data);
  const id = data.ids[Math.floor(Math.random() * data.ids.length)];
  const res = http.post(`${BASE_URL}/connections/${id}/sync`, JSON.stringify(randomWindow()), {
    headers: { "content-type": "application/json" },
    tags: { name: "POST /connections/:id/sync" },
  });
  if (res.status === 201) syncSucceeded.add(1);
  if (res.status === 503) syncRateLimited.add(1);
  if (res.status === 502) syncFailed.add(1);
  if (res.status === 409) syncBusy.add(1);
  // A taxa de sucesso conta só os syncs que de fato abriram um run (a resposta traz sync_run).
  // 409 (outro sync da conexão em andamento) e 503 sem run (conexão ainda bloqueada) não abrem run.
  const ranSync = [201, 502, 503].includes(res.status) && res.json("sync_run.id") !== undefined;
  if (ranSync) syncSuccessRate.add(res.status === 201);
  check(res, {
    "status é 201, 409, 502 ou 503": (r) => [201, 409, 502, 503].includes(r.status),
    "409 é sync_em_andamento": (r) => r.status !== 409 || r.json("error.code") === "sync_em_andamento",
    "201 traz sync_run succeeded": (r) => r.status !== 201 || r.json("sync_run.status") === "succeeded",
    "503 traz retry_at": (r) => r.status !== 503 || typeof r.json("retry_at") === "string",
  });
  // Cliente educado: com a conexão ocupada ou bloqueada, espera um pouco antes de tentar de novo.
  if (res.status === 409) sleep(0.2 + Math.random() * 0.3);
  if (res.status === 503) sleep(Math.min(1, Number(res.headers["Retry-After"] ?? "1")));
}

export function readMetrics(data) {
  const id = data.ids[Math.floor(Math.random() * data.ids.length)];
  const res = http.get(`${BASE_URL}/connections/${id}/metrics`, { tags: { name: "GET /connections/:id/metrics" } });
  check(res, { "metrics 200": (r) => r.status === 200 });
  sleep(0.05);
}
