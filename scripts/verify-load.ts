// Confere as invariantes depois da carga. Sai com código 1 se alguma quebrou.
import { DatabaseSync } from "node:sqlite";

const API_URL = process.env.API_URL ?? "http://localhost:3102";
const PROVIDER_URL = process.env.PROVIDER_URL ?? "http://localhost:3112";
const DB_PATH = process.env.DB_PATH;
const FULL_WINDOW = { since: "2026-09-01T00:00:00Z", until: "2026-09-09T00:00:00Z" };
if (!DB_PATH) throw new Error("DB_PATH é obrigatório");

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const problems: string[] = [];
const fail = (msg: string) => problems.push(msg);

interface Expected {
  posts: Array<{ id: string; views: number; likes: number; comments: number }>;
  totals: { views: number; likes: number; comments: number };
}

async function expectedFor(platform: string, account: string): Promise<Expected> {
  const res = await fetch(`${PROVIDER_URL}/__admin/accounts/${platform}/${account}/expected`);
  return (await res.json()) as Expected;
}

const stats = await (await fetch(`${PROVIDER_URL}/__admin/stats`)).json();
console.log("provedor durante a carga:", JSON.stringify(stats));

const runs = db.prepare("SELECT status, COUNT(*) AS n, SUM(attempts) AS attempts FROM sync_runs GROUP BY status").all();
console.log("sync_runs:", JSON.stringify(runs));
const running = db.prepare("SELECT COUNT(*) AS n FROM sync_runs WHERE status = 'running'").get() as { n: number };
if (running.n > 0) fail(`${running.n} sync_runs ficaram em running`);

// 1. Nenhuma medição repetida, e como o relógio do provedor estava parado, um snapshot por post.
const dupes = db.prepare(
  `SELECT connection_id, external_post_id, captured_at, COUNT(*) AS n FROM metric_snapshots
   GROUP BY connection_id, external_post_id, captured_at HAVING n > 1`,
).all();
if (dupes.length > 0) fail(`${dupes.length} snapshots duplicados: ${JSON.stringify(dupes.slice(0, 3))}`);
const multi = db.prepare(
  `SELECT connection_id, external_post_id, COUNT(*) AS n FROM metric_snapshots
   GROUP BY connection_id, external_post_id HAVING n > 1`,
).all();
if (multi.length > 0) fail(`${multi.length} posts com mais de um snapshot com o relógio do provedor parado`);

// 2. Cada número gravado durante a carga é igual ao do provedor.
const connections = db.prepare("SELECT id, creator_id, platform, external_account_id FROM connections ORDER BY id").all() as Array<{
  id: string;
  creator_id: string;
  platform: string;
  external_account_id: string;
}>;
// Os payloads inválidos da carga não podem ter criado conexão nenhuma além das 20 do setup.
if (connections.length !== 20) fail(`esperava 20 conexões, achei ${connections.length}`);
const snapshotsDuringLoad = (db.prepare("SELECT COUNT(*) AS n FROM metric_snapshots").get() as { n: number }).n;
const lookup = db.prepare(
  "SELECT external_post_id, views, likes, comments FROM metric_snapshots WHERE connection_id = ?",
);
for (const c of connections) {
  const expected = await expectedFor(c.platform, c.external_account_id);
  const byId = new Map(expected.posts.map((p) => [p.id, p]));
  for (const row of lookup.all(c.id) as Array<{ external_post_id: string; views: number; likes: number; comments: number }>) {
    const e = byId.get(row.external_post_id);
    if (!e) fail(`${c.id}: post ${row.external_post_id} não existe no provedor`);
    else if (e.views !== row.views || e.likes !== row.likes || e.comments !== row.comments) {
      fail(`${c.id}: métricas de ${row.external_post_id} divergem do provedor`);
    }
  }
}

// 3. Sem chaos, um sync final de cada conexão e os totais da API batem com o provedor.
const chaosOff = await fetch(`${PROVIDER_URL}/__admin/chaos`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ enabled: false }),
});
if (!chaosOff.ok) fail(`não consegui desligar o chaos do provedor (${chaosOff.status})`);
const creatorExpected = new Map<string, { posts: number; views: number; likes: number; comments: number }>();
for (const c of connections) {
  let res: Response | undefined;
  for (let i = 0; i < 10; i++) {
    res = await fetch(`${API_URL}/connections/${c.id}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(FULL_WINDOW),
    });
    if (res.status !== 503 && res.status !== 409) break;
    const wait = Number(res.headers.get("retry-after") ?? "1");
    await new Promise((r) => setTimeout(r, wait * 1000 + 50));
  }
  if (res?.status !== 201) {
    fail(`${c.id}: sync final respondeu ${res?.status}`);
    continue;
  }
  const expected = await expectedFor(c.platform, c.external_account_id);
  const metrics = (await (await fetch(`${API_URL}/connections/${c.id}/metrics`)).json()) as any;
  const want = { posts: expected.posts.length, ...expected.totals };
  const acc = creatorExpected.get(c.creator_id) ?? { posts: 0, views: 0, likes: 0, comments: 0 };
  creatorExpected.set(c.creator_id, {
    posts: acc.posts + want.posts,
    views: acc.views + want.views,
    likes: acc.likes + want.likes,
    comments: acc.comments + want.comments,
  });
  if (JSON.stringify(metrics.totals) !== JSON.stringify(want)) {
    fail(`${c.id}: totais ${JSON.stringify(metrics.totals)} diferem do provedor ${JSON.stringify(want)}`);
  }
}

for (const [creatorId, want] of creatorExpected) {
  const body = (await (await fetch(`${API_URL}/creators/${creatorId}/metrics`)).json()) as any;
  if (JSON.stringify(body.totals) !== JSON.stringify(want)) {
    fail(`criador ${creatorId}: totais ${JSON.stringify(body.totals)} diferem do esperado ${JSON.stringify(want)}`);
  }
}

const finalSnapshots = (db.prepare("SELECT COUNT(*) AS n FROM metric_snapshots").get() as { n: number }).n;
const finalPosts = (db.prepare("SELECT COUNT(*) AS n FROM posts").get() as { n: number }).n;
if (finalSnapshots !== finalPosts) fail(`snapshots (${finalSnapshots}) diferente de posts (${finalPosts})`);

console.log(
  `conexões: ${connections.length}, snapshots durante a carga: ${snapshotsDuringLoad}, ` +
    `depois do sync final: ${finalSnapshots} snapshots para ${finalPosts} posts`,
);

if (problems.length > 0) {
  console.error(`VERIFICAÇÃO FALHOU (${problems.length}):`);
  for (const p of problems.slice(0, 20)) console.error(` - ${p}`);
  process.exit(1);
}
console.log("verificação ok: nenhum snapshot duplicado, números iguais aos do provedor, totais conferem");
