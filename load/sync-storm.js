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
const syncSuccessRate = new Rate("sync_success_rate");

export const options = {
  scenarios: {
    syncs: { executor: "constant-vus", vus: 40, duration: "30s", exec: "syncStorm" },
    reads: { executor: "constant-vus", vus: 5, duration: "30s", exec: "readMetrics" },
  },
  thresholds: {
    checks: ["rate>0.99"],
    sync_success_rate: ["rate>0.8"],
    // 201 = sync completo; 503 = parou por limite de taxa (comportamento esperado sob 429 longo).
    http_req_failed: ["rate<0.05"],
    "http_req_duration{scenario:syncs}": ["p(95)<3000"],
    "http_req_duration{scenario:reads}": ["p(95)<300"],
  },
};

http.setResponseCallback(http.expectedStatuses(200, 201, 503));

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
  const id = data.ids[Math.floor(Math.random() * data.ids.length)];
  const res = http.post(`${BASE_URL}/connections/${id}/sync`, JSON.stringify(randomWindow()), {
    headers: { "content-type": "application/json" },
    tags: { name: "POST /connections/:id/sync" },
  });
  if (res.status === 201) syncSucceeded.add(1);
  if (res.status === 503) syncRateLimited.add(1);
  if (res.status === 502) syncFailed.add(1);
  syncSuccessRate.add(res.status === 201);
  check(res, {
    "status é 201, 502 ou 503": (r) => [201, 502, 503].includes(r.status),
    "201 traz sync_run succeeded": (r) => r.status !== 201 || r.json("sync_run.status") === "succeeded",
    "503 traz retry_at": (r) => r.status !== 503 || typeof r.json("retry_at") === "string",
  });
}

export function readMetrics(data) {
  const id = data.ids[Math.floor(Math.random() * data.ids.length)];
  const res = http.get(`${BASE_URL}/connections/${id}/metrics`, { tags: { name: "GET /connections/:id/metrics" } });
  check(res, { "metrics 200": (r) => r.status === 200 });
  sleep(0.05);
}
