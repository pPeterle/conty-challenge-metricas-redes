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

const ISO_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|([+-])(\d{2}):?(\d{2}))$/i;

/** Fusos reais vão de -12:00 a +14:00; aceito até ±14:00 para não depender de tabela de fusos. */
const MAX_OFFSET_MIN = 14 * 60;

/**
 * Conferência de ida e volta: o instante interpretado, visto no fuso que veio no texto, precisa ter
 * exatamente o mesmo ano, mês, dia, hora, minuto e segundo. Recusa 2026-02-30, qualquer
 * data que o Date do JS "conserte" sozinho e fuso impossível (+24:00, +23:60, -15:00).
 */
export function isExactInstant(value: string): boolean {
  const m = ISO_PARTS.exec(value);
  if (!m) return false;
  if (m[7] && (Number(m[9]) > 59 || Number(m[8]) * 60 + Number(m[9]) > MAX_OFFSET_MIN)) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  const offsetMin = m[7] ? (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9])) : 0;
  const local = new Date(ms + offsetMin * 60_000);
  return (
    local.getUTCFullYear() === Number(m[1]) &&
    local.getUTCMonth() + 1 === Number(m[2]) &&
    local.getUTCDate() === Number(m[3]) &&
    local.getUTCHours() === Number(m[4]) &&
    local.getUTCMinutes() === Number(m[5]) &&
    (m[6] === undefined || local.getUTCSeconds() === Number(m[6]))
  );
}

const strictInstant = (message: string) =>
  z.string().trim().datetime({ offset: true, message }).refine(isExactInstant, message);

const instant = (field: string) =>
  z
    .string({ required_error: `${field} é obrigatório`, invalid_type_error: `${field} deve ser texto` })
    .pipe(strictInstant(`${field} deve ser uma data ISO 8601 válida com fuso (ex.: 2026-09-01T00:00:00Z)`));

// ---------------------------------------------------------------- API

export const createConnectionSchema = z.object({
  creator_id: identifier("creator_id"),
  platform: z.enum(PLATFORMS, {
    errorMap: () => ({ message: `platform deve ser um de: ${PLATFORMS.join(", ")}` }),
  }),
  // Normalizado para "@Ana.Cria " e "ana.cria" serem a mesma conta (e baterem no UNIQUE).
  external_account_id: z
    .string({ required_error: "external_account_id é obrigatório", invalid_type_error: "external_account_id deve ser texto" })
    .transform((v) => v.trim().replace(/^@/, "").toLowerCase())
    .pipe(identifier("external_account_id")),
  access_token: z
    .string({ required_error: "access_token é obrigatório (pode ser fictício)", invalid_type_error: "access_token deve ser texto" })
    .trim()
    .min(1, "access_token não pode ser vazio")
    .max(4096, "access_token pode ter no máximo 4096 caracteres"),
});
export const replaceTokenSchema = z.object({ access_token: createConnectionSchema.shape.access_token });

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
    published_at: strictInstant("published_at inválido"),
    caption: z.string().max(10_000).nullish(),
    captured_at: strictInstant("captured_at inválido"),
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

const positiveInt = (fallback: number) =>
  z.coerce
    .number({ invalid_type_error: "deve ser um número" })
    .int("deve ser um inteiro")
    .positive("deve ser maior que zero")
    .safe("é grande demais")
    .default(fallback);

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
  SYNC_MAX_FUTURE_SKEW_MS: positiveInt(5 * 60 * 1000),
  SYNC_MAX_RATE_LIMIT_BLOCK_MS: positiveInt(24 * 3600 * 1000),
  SYNC_MAX_PAGES: positiveInt(100),
});
export type Env = z.output<typeof envSchema>;

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
    /** Tolerância para captured_at à frente do nosso relógio (relógios nunca batem exatamente). */
    maxFutureSkewMs: policyInt,
  })
  .refine((p) => p.maxTotalAttempts >= p.maxPages, {
    message: "maxTotalAttempts precisa ser pelo menos maxPages, senão um sync saudável nunca termina",
    path: ["maxTotalAttempts"],
  });
export type SyncPolicy = z.output<typeof syncPolicySchema>;
