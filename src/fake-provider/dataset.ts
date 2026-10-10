/**
 * Dados determinísticos do provedor simulado. Cada conta tem N posts publicados a cada
 * `intervalHours` a partir de DATASET_START, e os números crescem a cada hora desde a publicação.
 * O provedor mede de hora em hora: dentro da mesma hora, a mesma conta devolve o mesmo snapshot.
 */
export const DATASET_START = Date.parse("2026-09-01T00:00:00.000Z");
const HOUR = 3600 * 1000;

export interface DatasetOptions {
  postsPerAccount: number;
  intervalHours: number;
}

export const DEFAULT_DATASET: DatasetOptions = { postsPerAccount: 30, intervalHours: 6 };

export interface FakePost {
  id: string;
  publishedAt: number;
  caption: string;
}

export interface FakeMetrics {
  views: number;
  likes: number;
  comments: number;
}

function hash(text: string): number {
  // FNV-1a 32 bits: suficiente para números estáveis por post.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function listPosts(platform: string, account: string, options: DatasetOptions): FakePost[] {
  const posts: FakePost[] = [];
  for (let i = 0; i < options.postsPerAccount; i++) {
    posts.push({
      id: `${platform}-${account}-p${String(i + 1).padStart(3, "0")}`,
      publishedAt: DATASET_START + i * options.intervalHours * HOUR,
      caption: `Post ${i + 1} de ${account}`,
    });
  }
  return posts;
}

/** Instante da última medição do provedor: início da hora corrente. */
export function capturedAtFor(now: Date): number {
  return Math.floor(now.getTime() / HOUR) * HOUR;
}

export function metricsAt(platform: string, account: string, post: FakePost, capturedAt: number): FakeMetrics {
  const seed = hash(`${platform}:${account}:${post.id}`);
  const hours = Math.max(0, Math.floor((capturedAt - post.publishedAt) / HOUR));
  const views = 100 + (seed % 1000) + hours * ((seed % 50) + 1);
  const likes = Math.floor((views * ((seed % 7) + 3)) / 100);
  const comments = Math.floor(likes / 10);
  return { views, likes, comments };
}
