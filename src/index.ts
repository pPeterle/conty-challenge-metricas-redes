import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { realSleep, systemClock } from "./clock.ts";
import { openDatabase } from "./db.ts";
import { createLogger, exitAfterFlush, flushOnShutdown } from "./logger.ts";
import { HttpProviderClient } from "./provider/http-client.ts";
import { envSchema, type Env } from "./schemas.ts";

const logger = createLogger();

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Um teto NaN desligaria o limite de tentativas; melhor não subir.
  for (const issue of parsed.error.issues) {
    logger.fatal({ variavel: issue.path.join("."), motivo: issue.message }, "configuração inválida");
  }
  exitAfterFlush(logger, 1);
} else {
  start(parsed.data);
}

function start(env: Env) {
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
    logger,
  });

  const server = serve({ fetch: app.fetch, port: env.PORT }, () => {
    logger.info({ port: env.PORT, provider: env.PROVIDER_BASE_URL }, `API de métricas em http://localhost:${env.PORT}`);
  });
  flushOnShutdown(logger, () => server.close());
}
