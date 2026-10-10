import { serve } from "@hono/node-server";
import { systemClock, type Clock } from "../clock.ts";
import { createLogger, flushOnShutdown } from "../logger.ts";
import { createFakeProviderApp, type ChaosConfig } from "./app.ts";

const logger = createLogger().child({ servico: "provedor-simulado" });

const port = Number(process.env.PROVIDER_PORT ?? 3010);

// PROVIDER_FIXED_NOW congela o relógio do simulado (o teste de carga usa para ter um snapshot por post).
const fixedNow = process.env.PROVIDER_FIXED_NOW;
const clock: Clock = fixedNow ? { now: () => new Date(fixedNow) } : systemClock;

const chaos: ChaosConfig | null = process.env.PROVIDER_CHAOS === "1"
  ? {
      serverErrorRate: Number(process.env.CHAOS_5XX ?? 0.1),
      rateLimitRate: Number(process.env.CHAOS_429 ?? 0.05),
      rateLimitRetryAfter: process.env.CHAOS_RETRY_AFTER ?? "1",
      longRateLimitRate: Number(process.env.CHAOS_LONG_429 ?? 0.005),
      longRateLimitRetryAfter: process.env.CHAOS_LONG_RETRY_AFTER ?? "5",
      timeoutRate: Number(process.env.CHAOS_TIMEOUT ?? 0.02),
      timeoutHangMs: Number(process.env.CHAOS_TIMEOUT_HANG_MS ?? 3000),
      duplicateItemsRate: Number(process.env.CHAOS_DUPLICATE ?? 0.2),
    }
  : null;

// Semente fixa deixa a sequência de falhas sorteadas igual entre execuções da carga.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seed = process.env.CHAOS_SEED;
const random = seed ? seededRandom(Number(seed)) : Math.random;

const app = createFakeProviderApp({ clock, chaos, random, logger });
const server = serve({ fetch: app.fetch, port }, () => {
  logger.info({ port, chaos: chaos !== null }, `provedor simulado em http://localhost:${port}${chaos ? " (chaos ligado)" : ""}`);
});
flushOnShutdown(logger, () => server.close());
