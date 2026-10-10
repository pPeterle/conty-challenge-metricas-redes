import type { PageRequest, ProviderClient, ProviderPage, ProviderPost, ProviderResponse } from "./types.ts";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpProviderClientOptions {
  baseUrl: string;
  timeoutMs: number;
  /** Injetável: nos testes aponta direto para o app Hono do provedor simulado, sem porta. */
  fetch?: FetchLike;
}

class TimeoutError extends Error {}

export class HttpProviderClient implements ProviderClient {
  private readonly fetchFn: FetchLike;

  constructor(private readonly options: HttpProviderClientOptions) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async fetchPostsPage(request: PageRequest): Promise<ProviderResponse> {
    const url = new URL(
      `/v1/${request.platform}/accounts/${encodeURIComponent(request.externalAccountId)}/posts`,
      this.options.baseUrl,
    );
    url.searchParams.set("since", request.since.toISOString());
    url.searchParams.set("until", request.until.toISOString());
    if (request.cursor) url.searchParams.set("cursor", request.cursor);

    const controller = new AbortController();
    const timedOut = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new TimeoutError()), { once: true });
    });
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      // O corpo também fica dentro do timeout: um provedor pode mandar headers e travar no body.
      return await Promise.race([this.call(url.toString(), request.accessToken, controller.signal), timedOut]);
    } catch (error) {
      if (error instanceof TimeoutError) {
        return { kind: "transient", httpStatus: null, reason: `timeout após ${this.options.timeoutMs}ms` };
      }
      return { kind: "transient", httpStatus: null, reason: `erro de rede: ${(error as Error).message}` };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async call(url: string, token: string, signal: AbortSignal): Promise<ProviderResponse> {
    const res = await this.fetchFn(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal,
    });

    if (res.status === 429) {
      await res.body?.cancel();
      return { kind: "rate_limited", httpStatus: 429, retryAfter: res.headers.get("retry-after") };
    }
    if (res.status >= 500 || res.status === 408) {
      await res.body?.cancel();
      return { kind: "transient", httpStatus: res.status, reason: `provedor respondeu ${res.status}` };
    }
    if (res.status !== 200) {
      const text = await res.text().catch(() => "");
      return { kind: "permanent", httpStatus: res.status, reason: `provedor respondeu ${res.status} ${text.slice(0, 200)}`.trim() };
    }

    const body = await res.json().catch(() => undefined);
    const page = parsePage(body);
    if (!page) {
      return { kind: "permanent", httpStatus: 200, reason: "resposta do provedor fora do contrato" };
    }
    return { kind: "ok", httpStatus: 200, page };
  }
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * Converte o JSON do provedor para o modelo interno. As datas saem normalizadas em ISO UTC
 * com milissegundos, para que "10:00:00Z" e "10:00:00.000Z" virem a mesma chave de snapshot.
 */
export function parsePage(body: unknown): ProviderPage | null {
  if (typeof body !== "object" || body === null) return null;
  const { data, next_cursor } = body as Record<string, unknown>;
  if (!Array.isArray(data)) return null;
  if (next_cursor !== null && next_cursor !== undefined && typeof next_cursor !== "string") return null;

  const posts: ProviderPost[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) return null;
    const raw = item as Record<string, unknown>;
    const metrics = raw.metrics as Record<string, unknown> | undefined;
    if (typeof raw.id !== "string" || raw.id === "") return null;
    if (!isInstant(raw.published_at) || !isInstant(raw.captured_at)) return null;
    if (!metrics || !isCount(metrics.views) || !isCount(metrics.likes) || !isCount(metrics.comments)) return null;
    posts.push({
      externalId: raw.id,
      publishedAt: new Date(raw.published_at).toISOString(),
      caption: typeof raw.caption === "string" ? raw.caption : null,
      capturedAt: new Date(raw.captured_at).toISOString(),
      views: metrics.views,
      likes: metrics.likes,
      comments: metrics.comments,
    });
  }
  return { posts, nextCursor: typeof next_cursor === "string" && next_cursor !== "" ? next_cursor : null };
}
