import { createApp, type AppDeps } from "../../src/app.ts";
import { ManualClock } from "../../src/clock.ts";
import { openDatabase } from "../../src/db.ts";
import { createFakeProviderApp, type Fault } from "../../src/fake-provider/app.ts";
import { HttpProviderClient } from "../../src/provider/http-client.ts";
import type { ProviderClient } from "../../src/provider/types.ts";
import type { SyncPolicy } from "../../src/sync-service.ts";

export const START = "2026-10-01T10:15:00.000Z";
/** Janela que cobre os 30 posts do dataset (publicados de 01/09 a 08/09, um a cada 6h). */
export const FULL = { since: "2026-09-01T00:00:00Z", until: "2026-09-09T00:00:00Z" };

export const TEST_POLICY: SyncPolicy = {
  maxAttempts: 4,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  maxRetryAfterMs: 10_000,
  maxTotalWaitMs: 60_000,
  maxTotalAttempts: 40,
  staleRunMs: 15 * 60 * 1000,
  maxFutureSkewMs: 5 * 60 * 1000,
  maxRateLimitBlockMs: 24 * 3600 * 1000,
  maxPages: 20,
};

/**
 * API + provedor simulado no mesmo processo. A API fala com o provedor pelo cliente HTTP real;
 * só o transporte é trocado por `providerApp.request`, então não abre porta nenhuma.
 */
export function createHarness(
  overrides: { policy?: Partial<SyncPolicy>; timeoutMs?: number; provider?: ProviderClient } = {},
) {
  const clock = new ManualClock(START);
  const providerApp = createFakeProviderApp({ clock, pageSize: 10, overlapPages: true });
  let providerRequests = 0;
  const provider = new HttpProviderClient({
    baseUrl: "http://provider.test",
    timeoutMs: overrides.timeoutMs ?? 1_000,
    fetch: (input, init) => {
      providerRequests++;
      return Promise.resolve(providerApp.request(input, init));
    },
  });
  const db = openDatabase(":memory:");
  const deps: AppDeps = {
    db,
    clock,
    sleep: clock.sleep,
    provider: overrides.provider ?? provider,
    policy: { ...TEST_POLICY, ...overrides.policy },
  };
  const app = createApp(deps);

  async function json(method: string, path: string, body?: unknown) {
    const res = await app.request(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: (await res.json()) as any };
  }

  return {
    app,
    db,
    clock,
    json,
    get providerRequests() {
      return providerRequests;
    },
    async connect(input: { creator_id?: string; platform?: string; external_account_id?: string; access_token?: string } = {}) {
      const res = await json("POST", "/connections", {
        creator_id: "criadora-1",
        platform: "instagram",
        external_account_id: "conta-a",
        access_token: "token-fake",
        ...input,
      });
      if (res.status !== 201) throw new Error(`connect falhou: ${JSON.stringify(res.body)}`);
      return res.body.connection as { id: string; platform: string; external_account_id: string };
    },
    sync(connectionId: string, window: { since: string; until: string } = FULL) {
      return json("POST", `/connections/${connectionId}/sync`, window);
    },
    async faults(platform: string, account: string, faults: Fault[]) {
      await providerApp.request("/__admin/faults", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform, account, faults }),
      });
    },
    async expected(platform: string, account: string) {
      const res = await providerApp.request(`/__admin/accounts/${platform}/${account}/expected`);
      return (await res.json()) as {
        captured_at: string;
        posts: Array<{ id: string; views: number; likes: number; comments: number }>;
        totals: { views: number; likes: number; comments: number };
      };
    },
    snapshotCount(): number {
      return (db.prepare("SELECT COUNT(*) AS n FROM metric_snapshots").get() as { n: number }).n;
    },
  };
}
