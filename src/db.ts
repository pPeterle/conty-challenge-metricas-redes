import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Platform, ProviderPost } from "./provider/types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'tiktok', 'youtube', 'x')),
  external_account_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  rate_limited_until TEXT,
  -- needs_reauth: o provedor recusou o token (401); nenhum sync chama o provedor até um token novo.
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reauth')),
  created_at TEXT NOT NULL,
  UNIQUE (platform, external_account_id)
);
CREATE INDEX IF NOT EXISTS connections_creator ON connections (creator_id);

CREATE TABLE IF NOT EXISTS posts (
  connection_id TEXT NOT NULL REFERENCES connections (id),
  external_post_id TEXT NOT NULL,
  published_at TEXT NOT NULL,
  caption TEXT,
  first_fetched_at TEXT NOT NULL,
  last_fetched_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, external_post_id)
);
CREATE INDEX IF NOT EXISTS posts_connection_published ON posts (connection_id, published_at);

-- Uma linha por medição do provedor. A chave natural (conexão, post, captured_at) é o que
-- impede que a mesma medição entre duas vezes, venha de onde vier.
CREATE TABLE IF NOT EXISTS metric_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL,
  external_post_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  views INTEGER NOT NULL CHECK (views >= 0),
  likes INTEGER NOT NULL CHECK (likes >= 0),
  comments INTEGER NOT NULL CHECK (comments >= 0),
  fetched_at TEXT NOT NULL,
  sync_run_id TEXT NOT NULL,
  UNIQUE (connection_id, external_post_id, captured_at),
  FOREIGN KEY (connection_id, external_post_id) REFERENCES posts (connection_id, external_post_id)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections (id),
  window_since TEXT NOT NULL,
  window_until TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'rate_limited')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 0,
  items_received INTEGER NOT NULL DEFAULT 0,
  -- Posts que o provedor devolveu com published_at fora da janela pedida: descartados.
  items_out_of_window INTEGER NOT NULL DEFAULT 0,
  -- Posts com captured_at à frente do nosso relógio além da tolerância: descartados.
  items_captured_in_future INTEGER NOT NULL DEFAULT 0,
  snapshots_inserted INTEGER NOT NULL DEFAULT 0,
  snapshots_duplicated INTEGER NOT NULL DEFAULT 0,
  -- Mesmo (post, captured_at) chegando com números diferentes: vale o primeiro, o conflito fica registrado.
  snapshot_conflicts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  retry_at TEXT
);
CREATE INDEX IF NOT EXISTS sync_runs_connection ON sync_runs (connection_id, started_at);
-- No máximo um sync em andamento por conexão. Run abandonado é fechado antes de abrir o próximo.
CREATE UNIQUE INDEX IF NOT EXISTS sync_runs_one_running ON sync_runs (connection_id) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS sync_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_run_id TEXT NOT NULL REFERENCES sync_runs (id),
  page INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  http_status INTEGER,
  detail TEXT,
  wait_ms INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sync_attempts_run ON sync_attempts (sync_run_id, id);

-- O que o sync recusou ou estranhou no que o provedor mandou, item a item.
CREATE TABLE IF NOT EXISTS sync_anomalies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_run_id TEXT NOT NULL REFERENCES sync_runs (id),
  kind TEXT NOT NULL CHECK (kind IN ('fora_da_janela', 'captured_at_no_futuro', 'snapshot_conflitante')),
  external_post_id TEXT NOT NULL,
  detail TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sync_anomalies_run ON sync_anomalies (sync_run_id, id);
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
  }
  db.exec(SCHEMA);
  return db;
}

export interface ConnectionRow {
  id: string;
  creator_id: string;
  platform: Platform;
  external_account_id: string;
  access_token: string;
  rate_limited_until: string | null;
  status: "active" | "needs_reauth";
  created_at: string;
}

export type AnomalyKind = "fora_da_janela" | "captured_at_no_futuro" | "snapshot_conflitante";

export interface Anomaly {
  kind: AnomalyKind;
  externalPostId: string;
  detail: string;
}

export type SyncStatus = "running" | "succeeded" | "failed" | "rate_limited";

export interface SyncRunRow {
  id: string;
  connection_id: string;
  window_since: string;
  window_until: string;
  status: SyncStatus;
  started_at: string;
  finished_at: string | null;
  attempts: number;
  pages: number;
  items_received: number;
  items_out_of_window: number;
  items_captured_in_future: number;
  snapshots_inserted: number;
  snapshots_duplicated: number;
  snapshot_conflicts: number;
  error_code: string | null;
  error_message: string | null;
  retry_at: string | null;
}

export interface SyncAttemptRow {
  page: number;
  attempt: number;
  outcome: string;
  http_status: number | null;
  detail: string | null;
  wait_ms: number;
  at: string;
}

export interface PostWithMetricsRow {
  external_post_id: string;
  published_at: string;
  caption: string | null;
  first_fetched_at: string;
  last_fetched_at: string;
  captured_at: string;
  fetched_at: string;
  views: number;
  likes: number;
  comments: number;
  snapshots: number;
}

export interface SnapshotRow {
  captured_at: string;
  fetched_at: string;
  views: number;
  likes: number;
  comments: number;
  sync_run_id: string;
}

export interface TotalsRow {
  posts: number;
  views: number;
  likes: number;
  comments: number;
  last_fetched_at: string | null;
}

// Último snapshot por post, escolhido por captured_at (a medição mais recente do provedor),
// e não pela ordem de chegada. Totais sempre partem daqui: nunca somam snapshots do mesmo post.
// O filtro por conexão fica dentro da subconsulta para usar o índice UNIQUE e não varrer a tabela.
const latestSnapshots = (connectionFilter: string) => `
  SELECT * FROM (
    SELECT s.*, ROW_NUMBER() OVER (
      PARTITION BY s.connection_id, s.external_post_id ORDER BY s.captured_at DESC
    ) AS rn
    FROM metric_snapshots s
    WHERE s.connection_id ${connectionFilter}
  ) WHERE rn = 1
`;

export function createRepository(db: DatabaseSync) {
  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const stmts = {
    insertConnection: db.prepare(
      `INSERT INTO connections (id, creator_id, platform, external_account_id, access_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (platform, external_account_id) DO NOTHING`,
    ),
    connectionById: db.prepare(`SELECT * FROM connections WHERE id = ?`),
    markNeedsReauth: db.prepare(`UPDATE connections SET status = 'needs_reauth' WHERE id = ?`),
    replaceToken: db.prepare(`UPDATE connections SET access_token = ?, status = 'active' WHERE id = ?`),
    connectionByAccount: db.prepare(`SELECT * FROM connections WHERE platform = ? AND external_account_id = ?`),
    setRateLimitedUntil: db.prepare(
      // Nunca encurta um bloqueio já registrado por outro sync concorrente.
      `UPDATE connections SET rate_limited_until = ?
       WHERE id = ? AND (rate_limited_until IS NULL OR rate_limited_until < ?)`,
    ),
    insertRun: db.prepare(
      `INSERT INTO sync_runs (id, connection_id, window_since, window_until, status, started_at)
       VALUES (?, ?, ?, ?, 'running', ?)`,
    ),
    runById: db.prepare(`SELECT * FROM sync_runs WHERE id = ?`),
    runningRun: db.prepare(`SELECT id FROM sync_runs WHERE connection_id = ? AND status = 'running'`),
    abandonStaleRuns: db.prepare(
      `UPDATE sync_runs SET status = 'failed', finished_at = ?, error_code = 'abandonado',
         error_message = 'execução ficou em running além do limite e foi dada como abandonada'
       WHERE connection_id = ? AND status = 'running' AND started_at < ?`,
    ),
    runsByConnection: db.prepare(`SELECT * FROM sync_runs WHERE connection_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?`),
    insertAttempt: db.prepare(
      `INSERT INTO sync_attempts (sync_run_id, page, attempt, outcome, http_status, detail, wait_ms, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    bumpAttempts: db.prepare(`UPDATE sync_runs SET attempts = attempts + 1 WHERE id = ?`),
    snapshotByKey: db.prepare(
      `SELECT views, likes, comments FROM metric_snapshots
       WHERE connection_id = ? AND external_post_id = ? AND captured_at = ?`,
    ),
    insertAnomaly: db.prepare(
      `INSERT INTO sync_anomalies (sync_run_id, kind, external_post_id, detail, at) VALUES (?, ?, ?, ?, ?)`,
    ),
    anomaliesByRun: db.prepare(
      `SELECT kind, external_post_id, detail, at FROM sync_anomalies WHERE sync_run_id = ? ORDER BY id LIMIT 200`,
    ),
    attemptsByRun: db.prepare(
      `SELECT page, attempt, outcome, http_status, detail, wait_ms, at FROM sync_attempts WHERE sync_run_id = ? ORDER BY id`,
    ),
    upsertPost: db.prepare(
      `INSERT INTO posts (connection_id, external_post_id, published_at, caption, first_fetched_at, last_fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (connection_id, external_post_id) DO UPDATE SET
         published_at = excluded.published_at,
         caption = excluded.caption,
         last_fetched_at = max(posts.last_fetched_at, excluded.last_fetched_at)`,
    ),
    insertSnapshot: db.prepare(
      `INSERT INTO metric_snapshots
         (connection_id, external_post_id, captured_at, views, likes, comments, fetched_at, sync_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (connection_id, external_post_id, captured_at) DO NOTHING`,
    ),
    addPageCounters: db.prepare(
      `UPDATE sync_runs SET pages = pages + 1, items_received = items_received + ?,
         items_out_of_window = items_out_of_window + ?, items_captured_in_future = items_captured_in_future + ?,
         snapshots_inserted = snapshots_inserted + ?, snapshots_duplicated = snapshots_duplicated + ?,
         snapshot_conflicts = snapshot_conflicts + ?
       WHERE id = ?`,
    ),
    finishRun: db.prepare(
      `UPDATE sync_runs SET status = ?, finished_at = ?, error_code = ?, error_message = ?, retry_at = ?
       WHERE id = ?`,
    ),
    postsWithMetrics: db.prepare(
      `SELECT p.external_post_id, p.published_at, p.caption, p.first_fetched_at, p.last_fetched_at,
              l.captured_at, l.fetched_at, l.views, l.likes, l.comments,
              (SELECT COUNT(*) FROM metric_snapshots s
                WHERE s.connection_id = p.connection_id AND s.external_post_id = p.external_post_id) AS snapshots
       FROM posts p
       JOIN (${latestSnapshots("= ?")}) l ON l.connection_id = p.connection_id AND l.external_post_id = p.external_post_id
       WHERE p.connection_id = ?
       ORDER BY p.published_at DESC, p.external_post_id
       LIMIT ? OFFSET ?`,
    ),
    snapshotsOfPost: db.prepare(
      `SELECT captured_at, fetched_at, views, likes, comments, sync_run_id FROM metric_snapshots
       WHERE connection_id = ? AND external_post_id = ? ORDER BY captured_at DESC LIMIT ? OFFSET ?`,
    ),
    postExists: db.prepare(`SELECT 1 FROM posts WHERE connection_id = ? AND external_post_id = ?`),
    connectionTotals: db.prepare(
      `SELECT COUNT(*) AS posts, COALESCE(SUM(views), 0) AS views, COALESCE(SUM(likes), 0) AS likes,
              COALESCE(SUM(comments), 0) AS comments,
              (SELECT MAX(last_fetched_at) FROM posts WHERE connection_id = ?) AS last_fetched_at
       FROM (${latestSnapshots("= ?")})`,
    ),
    creatorTotalsByPlatform: db.prepare(
      `SELECT c.platform, COUNT(l.id) AS posts, COALESCE(SUM(l.views), 0) AS views,
              COALESCE(SUM(l.likes), 0) AS likes, COALESCE(SUM(l.comments), 0) AS comments,
              (SELECT MAX(p.last_fetched_at) FROM posts p JOIN connections c2 ON c2.id = p.connection_id
                WHERE c2.creator_id = c.creator_id AND c2.platform = c.platform) AS last_fetched_at
       FROM connections c
       LEFT JOIN (${latestSnapshots("IN (SELECT id FROM connections WHERE creator_id = ?)")}) l ON l.connection_id = c.id
       WHERE c.creator_id = ?
       GROUP BY c.platform
       ORDER BY c.platform`,
    ),
  };

  return {
    transaction,

    /** Devolve a conexão e se ela foi criada agora (false = já existia para a mesma conta). */
    createConnection(input: Omit<ConnectionRow, "rate_limited_until" | "status">): { row: ConnectionRow; created: boolean } {
      const res = stmts.insertConnection.run(
        input.id, input.creator_id, input.platform, input.external_account_id, input.access_token, input.created_at,
      );
      const row = stmts.connectionByAccount.get(input.platform, input.external_account_id) as unknown as ConnectionRow;
      return { row, created: res.changes === 1 };
    },

    getConnection(id: string): ConnectionRow | undefined {
      return stmts.connectionById.get(id) as ConnectionRow | undefined;
    },

    markNeedsReauth(connectionId: string): void {
      stmts.markNeedsReauth.run(connectionId);
    },

    /** Token novo reativa a conexão. */
    replaceToken(connectionId: string, token: string): ConnectionRow | undefined {
      stmts.replaceToken.run(token, connectionId);
      return stmts.connectionById.get(connectionId) as ConnectionRow | undefined;
    },

    markRateLimited(connectionId: string, until: string): void {
      stmts.setRateLimitedUntil.run(until, connectionId, until);
    },

    /** Fecha runs que ficaram em running (processo caiu no meio). Devolve quantos foram fechados. */
    abandonStaleRuns(connectionId: string, startedBefore: string, now: string): number {
      return Number(stmts.abandonStaleRuns.run(now, connectionId, startedBefore).changes);
    },

    /** Abre o run. Se já existe um em running para a conexão, devolve o id dele e não abre nada. */
    startRun(input: { id: string; connectionId: string; since: string; until: string; startedAt: string }): { runningId: string } | null {
      try {
        stmts.insertRun.run(input.id, input.connectionId, input.since, input.until, input.startedAt);
        return null;
      } catch (error) {
        if (!/UNIQUE constraint failed: sync_runs\.connection_id/.test(String((error as Error).message))) throw error;
        const running = stmts.runningRun.get(input.connectionId) as { id: string } | undefined;
        return { runningId: running?.id ?? "desconhecido" };
      }
    },

    recordAttempt(runId: string, a: SyncAttemptRow): void {
      transaction(() => {
        stmts.insertAttempt.run(runId, a.page, a.attempt, a.outcome, a.http_status, a.detail, a.wait_ms, a.at);
        stmts.bumpAttempts.run(runId);
      });
    },

    /**
     * Grava uma página inteira numa transação. Snapshot repetido (mesmo post e mesmo captured_at,
     * vindo de página sobreposta, janela sobreposta ou sync concorrente) é ignorado pelo ON CONFLICT.
     */
    ingestPage(runId: string, connectionId: string, posts: ProviderPost[], fetchedAt: string, rejected: Anomaly[] = []) {
      return transaction(() => {
        for (const a of rejected) stmts.insertAnomaly.run(runId, a.kind, a.externalPostId, a.detail, fetchedAt);
        const outOfWindow = rejected.filter((a) => a.kind === "fora_da_janela").length;
        const inFuture = rejected.filter((a) => a.kind === "captured_at_no_futuro").length;
        let inserted = 0;
        let conflicts = 0;
        for (const p of posts) {
          stmts.upsertPost.run(connectionId, p.externalId, p.publishedAt, p.caption, fetchedAt, fetchedAt);
          const res = stmts.insertSnapshot.run(
            connectionId, p.externalId, p.capturedAt, p.views, p.likes, p.comments, fetchedAt, runId,
          );
          if (res.changes === 1) {
            inserted++;
            continue;
          }
          const kept = stmts.snapshotByKey.get(connectionId, p.externalId, p.capturedAt) as
            | { views: number; likes: number; comments: number }
            | undefined;
          if (kept && (kept.views !== p.views || kept.likes !== p.likes || kept.comments !== p.comments)) {
            conflicts++;
            const detail = `captured_at=${p.capturedAt} gravado=${JSON.stringify(kept)} recebido=${JSON.stringify({ views: p.views, likes: p.likes, comments: p.comments })}`;
            stmts.insertAnomaly.run(runId, "snapshot_conflitante", p.externalId, detail, fetchedAt);
          }
        }
        const duplicated = posts.length - inserted;
        stmts.addPageCounters.run(posts.length + rejected.length, outOfWindow, inFuture, inserted, duplicated, conflicts, runId);
        return { inserted, duplicated, conflicts };
      });
    },

    finishRun(runId: string, f: { status: SyncStatus; finishedAt: string; errorCode?: string; errorMessage?: string; retryAt?: string }) {
      stmts.finishRun.run(f.status, f.finishedAt, f.errorCode ?? null, f.errorMessage ?? null, f.retryAt ?? null, runId);
    },

    getRun(id: string): SyncRunRow | undefined {
      return stmts.runById.get(id) as SyncRunRow | undefined;
    },

    listRuns(connectionId: string, limit = 50, offset = 0): SyncRunRow[] {
      return stmts.runsByConnection.all(connectionId, limit, offset) as unknown as SyncRunRow[];
    },

    listAnomalies(runId: string): Array<{ kind: AnomalyKind; external_post_id: string; detail: string; at: string }> {
      return stmts.anomaliesByRun.all(runId) as unknown as Array<{ kind: AnomalyKind; external_post_id: string; detail: string; at: string }>;
    },

    listAttempts(runId: string): SyncAttemptRow[] {
      return stmts.attemptsByRun.all(runId) as unknown as SyncAttemptRow[];
    },

    listPosts(connectionId: string, limit = 100, offset = 0): PostWithMetricsRow[] {
      return stmts.postsWithMetrics.all(connectionId, connectionId, limit, offset) as unknown as PostWithMetricsRow[];
    },

    postExists(connectionId: string, externalPostId: string): boolean {
      return stmts.postExists.get(connectionId, externalPostId) !== undefined;
    },

    listSnapshots(connectionId: string, externalPostId: string, limit = 100, offset = 0): SnapshotRow[] {
      return stmts.snapshotsOfPost.all(connectionId, externalPostId, limit, offset) as unknown as SnapshotRow[];
    },

    connectionTotals(connectionId: string): TotalsRow {
      return stmts.connectionTotals.get(connectionId, connectionId) as unknown as TotalsRow;
    },

    creatorTotalsByPlatform(creatorId: string): Array<TotalsRow & { platform: Platform }> {
      return stmts.creatorTotalsByPlatform.all(creatorId, creatorId) as unknown as Array<TotalsRow & { platform: Platform }>;
    },
  };
}

export type Repository = ReturnType<typeof createRepository>;
