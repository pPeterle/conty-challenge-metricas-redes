import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { realSleep, systemClock } from "./clock.ts";
import { openDatabase } from "./db.ts";
import { HttpProviderClient } from "./provider/http-client.ts";
import { envSchema } from "./schemas.ts";

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Um teto NaN desligaria o limite de tentativas; melhor não subir.
  for (const issue of parsed.error.issues) console.error(`configuração inválida: ${issue.path.join(".")}: ${issue.message}`);
  process.exit(1);
}
const env = parsed.data;

const db = openDatabase(env.DB_PATH);
const provider = new HttpProviderClient({ baseUrl: env.PROVIDER_BASE_URL, timeoutMs: env.PROVIDER_TIMEOUT_MS });

const app = createApp({
  db,
  clock: systemClock,
  sleep: realSleep,
  provider,
  policy: {
    maxAttempts: env.SYNC_MAX_ATTEMPTS,
    baseDelayMs: env.SYNC_BACKOFF_BASE_MS,
    maxDelayMs: env.SYNC_BACKOFF_MAX_MS,
    maxRetryAfterMs: env.SYNC_MAX_RETRY_AFTER_MS,
    maxTotalWaitMs: env.SYNC_MAX_TOTAL_WAIT_MS,
    maxTotalAttempts: env.SYNC_MAX_TOTAL_ATTEMPTS,
    staleRunMs: env.SYNC_STALE_RUN_MS,
    maxFutureSkewMs: env.SYNC_MAX_FUTURE_SKEW_MS,
    maxRateLimitBlockMs: env.SYNC_MAX_RATE_LIMIT_BLOCK_MS,
    maxPages: env.SYNC_MAX_PAGES,
  },
});

serve({ fetch: app.fetch, port: env.PORT }, () => {
  console.log(`API de métricas em http://localhost:${env.PORT}`);
});
