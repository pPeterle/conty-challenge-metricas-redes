import { z } from "zod";
import { PLATFORMS } from "./provider/types.ts";

/**
 * Todos os schemas de entrada externa num lugar só: corpo e query da API, parâmetros de rota,
 * resposta do provedor e variáveis de ambiente. Objetos usam o padrão do zod (strip): campo
 * desconhecido é descartado, não quebra.
 */

const DAY_MS = 24 * 3600 * 1000;
export const MAX_WINDOW_DAYS = 90;
export const MAX_PAGE_LIMIT = 200;

const identifier = (field: string) =>
  z
    .string({ required_error: `${field} é obrigatório`, invalid_type_error: `${field} deve ser texto` })
    .trim()
    .min(1, `${field} não pode ser vazio`)
    .max(128, `${field} pode ter no máximo 128 caracteres`)
    .regex(/^[A-Za-z0-9._-]+$/, `${field} aceita só letras, números, ponto, hífen e sublinhado`);

const instant = (field: string) =>
  z
    .string({ required_error: `${field} é obrigatório`, invalid_type_error: `${field} deve ser texto` })
    .trim()
    .datetime({ offset: true, message: `${field} deve ser uma data ISO 8601 válida com fuso (ex.: 2026-09-01T00:00:00Z)` });

// ---------------------------------------------------------------- API

export const createConnectionSchema = z.object({
  creator_id: identifier("creator_id"),
  platform: z.enum(PLATFORMS, {
    errorMap: () => ({ message: `platform deve ser um de: ${PLATFORMS.join(", ")}` }),
  }),
  external_account_id: identifier("external_account_id"),
  access_token: z
    .string({ required_error: "access_token é obrigatório (pode ser fictício)", invalid_type_error: "access_token deve ser texto" })
    .trim()
    .min(1, "access_token não pode ser vazio")
    .max(4096, "access_token pode ter no máximo 4096 caracteres"),
});
export type CreateConnectionInput = z.output<typeof createConnectionSchema>;

/** Janela meio aberta [since, until) sobre a data de publicação do post. */
export const syncWindowSchema = z
  .object({ since: instant("since"), until: instant("until") })
  .transform((w) => ({ since: new Date(w.since), until: new Date(w.until) }))
  .superRefine((w, ctx) => {
    const span = w.until.getTime() - w.since.getTime();
    if (span <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["until"], message: "since precisa ser anterior a until" });
    } else if (span > MAX_WINDOW_DAYS * DAY_MS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["until"], message: `a janela pode ter no máximo ${MAX_WINDOW_DAYS} dias` });
    }
  });
export type SyncWindow = z.output<typeof syncWindowSchema>;

const queryInt = (field: string, min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,6}$/, `${field} deve ser um inteiro entre ${min} e ${max}`)
    .transform(Number)
    .pipe(z.number().int().min(min, `${field} deve ser um inteiro entre ${min} e ${max}`).max(max, `${field} deve ser um inteiro entre ${min} e ${max}`));

export const paginationSchema = (defaultLimit: number) =>
  z.object({
    limit: queryInt("limit", 1, MAX_PAGE_LIMIT).default(String(defaultLimit)),
    offset: queryInt("offset", 0, 1_000_000).default("0"),
  });

/** Ids de rota: só limitamos o tamanho. Um id que não existe vira 404 na busca. */
const routeId = z.string().min(1).max(256, "id pode ter no máximo 256 caracteres");
export const connectionParamsSchema = z.object({ id: routeId });
export const postParamsSchema = z.object({ id: routeId, postId: routeId });
export const creatorParamsSchema = z.object({ creatorId: routeId });

// ---------------------------------------------------------------- provedor

const count = z.number().int().nonnegative().safe();

const providerPostSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    published_at: z.string().datetime({ offset: true }),
    caption: z.string().max(10_000).nullish(),
    captured_at: z.string().datetime({ offset: true }),
    metrics: z.object({ views: count, likes: count, comments: count }),
  })
  // Datas normalizadas em ISO UTC com milissegundos: "10:00:00Z" e "07:00:00.000-03:00" viram a mesma chave.
  .transform((p) => ({
    externalId: p.id,
    publishedAt: new Date(p.published_at).toISOString(),
    caption: p.caption ?? null,
    capturedAt: new Date(p.captured_at).toISOString(),
    views: p.metrics.views,
    likes: p.metrics.likes,
    comments: p.metrics.comments,
  }));

export const providerPageSchema = z
  .object({
    data: z.array(providerPostSchema).max(1_000),
    next_cursor: z.string().max(2_048).nullish(),
  })
  .transform((page) => ({
    posts: page.data,
    nextCursor: page.next_cursor ? page.next_cursor : null,
  }));

// ---------------------------------------------------------------- configuração

const positiveInt = (fallback: number) => z.coerce.number().int().positive().safe().default(fallback);

/** Variáveis de ambiente da API. Valor inválido (NaN, zero, negativo) impede a subida. */
export const envSchema = z.object({
  PORT: positiveInt(3000),
  DB_PATH: z.string().trim().min(1).default("data/metrics.sqlite"),
  PROVIDER_BASE_URL: z.string().url().default("http://localhost:3010"),
  PROVIDER_TIMEOUT_MS: positiveInt(5_000),
  SYNC_MAX_ATTEMPTS: positiveInt(5),
  SYNC_BACKOFF_BASE_MS: positiveInt(500),
  SYNC_BACKOFF_MAX_MS: positiveInt(8_000),
  SYNC_MAX_RETRY_AFTER_MS: positiveInt(30_000),
  SYNC_MAX_TOTAL_WAIT_MS: positiveInt(60_000),
  SYNC_MAX_TOTAL_ATTEMPTS: positiveInt(300),
  SYNC_STALE_RUN_MS: positiveInt(15 * 60 * 1000),
  SYNC_MAX_RATE_LIMIT_BLOCK_MS: positiveInt(24 * 3600 * 1000),
  SYNC_MAX_PAGES: positiveInt(100),
});

const policyInt = z.number().int().positive().safe();
export const syncPolicySchema = z
  .object({
    maxAttempts: policyInt,
    baseDelayMs: policyInt,
    maxDelayMs: policyInt,
    maxRetryAfterMs: policyInt,
    maxTotalWaitMs: policyInt,
    maxTotalAttempts: policyInt,
    maxRateLimitBlockMs: policyInt,
    maxPages: policyInt,
    /** Run em running mais velho que isso é considerado abandonado (processo caiu no meio). */
    staleRunMs: policyInt,
  })
  .refine((p) => p.maxTotalAttempts >= p.maxPages, {
    message: "maxTotalAttempts precisa ser pelo menos maxPages, senão um sync saudável nunca termina",
    path: ["maxTotalAttempts"],
  });
export type SyncPolicy = z.output<typeof syncPolicySchema>;
