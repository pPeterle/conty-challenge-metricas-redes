/**
 * Fronteira com o provedor de métricas. O SyncService só conhece este contrato;
 * ele não sabe de HTTP, headers nem do formato JSON do provedor.
 */
export const PLATFORMS = ["instagram", "tiktok", "youtube", "x"] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface ProviderPost {
  externalId: string;
  publishedAt: string;
  caption: string | null;
  /** Momento em que o provedor mediu os números (não é quando buscamos). */
  capturedAt: string;
  views: number;
  likes: number;
  comments: number;
}

export interface ProviderPage {
  posts: ProviderPost[];
  nextCursor: string | null;
}

export interface PageRequest {
  platform: Platform;
  externalAccountId: string;
  accessToken: string;
  since: Date;
  until: Date;
  cursor: string | null;
}

/** Resultado de UMA chamada. O cliente classifica; quem decide se repete é o SyncService. */
export type ProviderResponse =
  | { kind: "ok"; httpStatus: number; page: ProviderPage }
  | { kind: "transient"; httpStatus: number | null; reason: string }
  | { kind: "rate_limited"; httpStatus: 429; retryAfter: string | null }
  | { kind: "permanent"; httpStatus: number | null; reason: string };

export interface ProviderClient {
  fetchPostsPage(request: PageRequest): Promise<ProviderResponse>;
}
