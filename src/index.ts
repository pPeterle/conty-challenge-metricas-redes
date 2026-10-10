import { serve } from "@hono/node-server";
import { createApp, DEFAULT_POLICY } from "./app.ts";
import { realSleep, systemClock } from "./clock.ts";
import { openDatabase } from "./db.ts";
import { HttpProviderClient } from "./provider/http-client.ts";

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

const port = env("PORT", 3000);
const db = openDatabase(process.env.DB_PATH ?? "data/metrics.sqlite");
const provider = new HttpProviderClient({
  baseUrl: process.env.PROVIDER_BASE_URL ?? "http://localhost:3010",
  timeoutMs: env("PROVIDER_TIMEOUT_MS", 5_000),
});

const app = createApp({
  db,
  clock: systemClock,
  sleep: realSleep,
  provider,
  policy: {
    maxAttempts: env("SYNC_MAX_ATTEMPTS", DEFAULT_POLICY.maxAttempts),
    baseDelayMs: env("SYNC_BACKOFF_BASE_MS", DEFAULT_POLICY.baseDelayMs),
    maxDelayMs: env("SYNC_BACKOFF_MAX_MS", DEFAULT_POLICY.maxDelayMs),
    maxRetryAfterMs: env("SYNC_MAX_RETRY_AFTER_MS", DEFAULT_POLICY.maxRetryAfterMs),
    maxPages: env("SYNC_MAX_PAGES", DEFAULT_POLICY.maxPages),
  },
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`API de métricas em http://localhost:${port}`);
});
