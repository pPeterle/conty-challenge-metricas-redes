import { serve } from "@hono/node-server";
import { systemClock, type Clock } from "../clock.ts";
import { createFakeProviderApp, type ChaosConfig } from "./app.ts";

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

const app = createFakeProviderApp({ clock, chaos });
serve({ fetch: app.fetch, port }, () => {
  console.log(`provedor simulado em http://localhost:${port}${chaos ? " (chaos ligado)" : ""}`);
});
