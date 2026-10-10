import { providerPageSchema } from "../schemas.ts";
import type { PageRequest, ProviderClient, ProviderPage, ProviderResponse } from "./types.ts";

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

/** Valida o JSON do provedor com zod e converte para o modelo interno. null = fora do contrato. */
export function parsePage(body: unknown): ProviderPage | null {
  const parsed = providerPageSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
