// Память кошельков роя в SQLite (DATA_DIR/brain.db) вместо meta walletMem с потолком 8000 кошельков × 20 токенов.
// wallet_roles — роль кошелька в токене (одна на пару кошелёк+токен), op_members — группы связанных кошельков одного
// токена (оператор скана). Раз в 10 минут из групп собираются операторы между токенами: кошельки, которые оказывались
// в одной группе на 2+ разных токенах, сливаются (union-find) в постоянного оператора op_<хэш>.
// Встроенный node:sqlite: без нативных модулей. Не открылась база — memDb() вернёт null, и память читается из meta как раньше.
import "server-only";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";

// dev — настоящий создатель (кошелёк, подписавший выпуск), factory — контракт лаунчпада/фабрики, который выпускает
// токены за многих людей, pool — кто создал пул ликвидности. Раньше фабрику записывали как dev.
export type MemRole = "sniper" | "bundle" | "dev" | "funder" | "holder" | "linked" | "factory" | "pool";
export interface MemRow {
  wallet: string;
  token: string;
  chain: string;
  role: MemRole;
  at: number;
}

const OPS_EVERY = 10 * 60_000;
// Кошелёк, который был в группах больше чем на HUB_TOKENS токенах, скорее роутер или общий сервис, а не чей-то оператор.
const HUB_TOKENS = 60;
// Пары внутри огромной группы не строим: это уже не «свои» кошельки, а шум.
const GROUP_MAX = 60;

interface Db {
  db: DatabaseSync;
  put: StatementSync;
  member: StatementSync;
  byWallets: StatementSync;
  count: StatementSync;
}
const host = globalThis as unknown as { __crawlhiveMemDb?: Db | null; __crawlhiveOps?: Ops };
let opsTimer: ReturnType<typeof setInterval> | undefined;

export function memDb(): Db | null {
  if (host.__crawlhiveMemDb !== undefined) return host.__crawlhiveMemDb;
  try {
    // getBuiltinModule, а не import: сборщик не трогает node:sqlite, а без него (старый Node) просто откатываемся на meta.
    const mod = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined;
    if (!mod) throw new Error("node:sqlite is not available in this Node version");
    const { DatabaseSync } = mod;
    const dir = process.env.DATA_DIR?.trim() || path.join(/* turbopackIgnore: true */ process.cwd(), ".data");
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, "brain.db"));
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS wallet_roles (wallet TEXT NOT NULL, token TEXT NOT NULL, chain TEXT NOT NULL, role TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (wallet, token)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS wallet_roles_token ON wallet_roles (token);
      CREATE TABLE IF NOT EXISTS op_members (token TEXT NOT NULL, grp TEXT NOT NULL, wallet TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (token, grp, wallet)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS op_members_wallet ON op_members (wallet);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS watch (owner TEXT NOT NULL, target TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL, PRIMARY KEY (owner, target)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS watch_target ON watch (target);
      CREATE TABLE IF NOT EXISTS watch_alerts (owner TEXT NOT NULL, target TEXT NOT NULL, token TEXT NOT NULL, chain TEXT NOT NULL, role TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (owner, target, token)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS watch_alerts_owner ON watch_alerts (owner, at);
      CREATE TABLE IF NOT EXISTS watch_ops (owner TEXT NOT NULL, anchor TEXT NOT NULL, op TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL, PRIMARY KEY (owner, anchor)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS watch_op_alerts (owner TEXT NOT NULL, anchor TEXT NOT NULL, op TEXT NOT NULL, token TEXT NOT NULL, chain TEXT NOT NULL, members TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (owner, anchor, token)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS watch_op_alerts_owner ON watch_op_alerts (owner, at);
      CREATE TABLE IF NOT EXISTS launches (token TEXT PRIMARY KEY, chain TEXT NOT NULL, deployer TEXT, factory TEXT, pool_creator TEXT, tx TEXT, launched_at INTEGER, seen_at INTEGER NOT NULL) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS launches_deployer ON launches (deployer);
      CREATE INDEX IF NOT EXISTS launches_factory ON launches (factory);
    `);
    host.__crawlhiveMemDb = {
      db,
      put: db.prepare("INSERT INTO wallet_roles (wallet, token, chain, role, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (wallet, token) DO UPDATE SET chain = excluded.chain, role = excluded.role, at = excluded.at"),
      member: db.prepare("INSERT OR IGNORE INTO op_members (token, grp, wallet, at) VALUES (?, ?, ?, ?)"),
      byWallets: db.prepare("SELECT wallet, token, chain, role, at FROM wallet_roles WHERE wallet IN (SELECT value FROM json_each(?)) ORDER BY at"),
      count: db.prepare("SELECT COUNT(DISTINCT wallet) AS n FROM wallet_roles"),
    };
    opsTimer ??= setInterval(() => rebuildOperators(), OPS_EVERY);
    opsTimer.unref?.();
  } catch (e) {
    console.warn("[memory] SQLite unavailable, falling back to meta:", (e as Error).message);
    host.__crawlhiveMemDb = null;
  }
  return host.__crawlhiveMemDb;
}

function tx(db: DatabaseSync, fn: () => void) {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// Запись одного скана: роли кошельков и группы связанных кошельков (по 2+ кошелька).
export function writeScan(d: Db, token: string, chain: string, roles: Map<string, MemRole>, groups: string[][] = []) {
  const at = Date.now();
  tx(d.db, () => {
    for (const [w, r] of roles) d.put.run(w, token, chain, r, at);
    groups.forEach((g, i) => {
      const ws = [...new Set(g)];
      if (ws.length < 2 || ws.length > GROUP_MAX) return;
      for (const w of ws) d.member.run(token, `g${i}`, w, at);
    });
  });
}

export function rowsFor(d: Db, wallets: string[]): MemRow[] {
  if (!wallets.length) return [];
  return d.byWallets.all(JSON.stringify(wallets)) as unknown as MemRow[];
}

export const walletCount = (d: Db) => Number((d.count.get() as { n: number }).n);

// Перенос старой памяти из meta: idempotent, второй раз ничего не меняет. У старых записей нет времени и групп:
// время берём из Track Record (или 0), группой токена считаем его держателей, бандлы, спонсоров и девов. Снайперов
// в общую группу не кладём: одни и те же снайпер-боты есть почти на каждом токене, они склеили бы всех.
export function migrateLegacy(d: Db, legacy: Record<string, (string | { t: string; c: string; r: MemRole })[]>, timeOf: (token: string) => number) {
  const done = d.db.prepare("SELECT v FROM kv WHERE k = 'migrated_walletMem'").get() as { v: string } | undefined;
  if (done) return 0;
  const ins = d.db.prepare("INSERT OR IGNORE INTO wallet_roles (wallet, token, chain, role, at) VALUES (?, ?, ?, ?, ?)");
  const groups = new Map<string, Set<string>>();
  let n = 0;
  tx(d.db, () => {
    for (const [w, list] of Object.entries(legacy)) {
      for (const raw of list ?? []) {
        const e = typeof raw === "string" ? { t: raw, c: "solana", r: "linked" as MemRole } : raw;
        ins.run(w, e.t, e.c, e.r, timeOf(e.t));
        if (e.r === "holder" || e.r === "bundle" || e.r === "funder" || e.r === "dev") groups.set(e.t, (groups.get(e.t) ?? new Set()).add(w));
      }
      n++;
    }
    for (const [t, ws] of groups) if (ws.size >= 2 && ws.size <= GROUP_MAX) for (const w of ws) d.member.run(t, "legacy", w, timeOf(t));
    d.db.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('migrated_walletMem', ?)").run(String(Date.now()));
  });
  console.log(`[memory] migrated ${n} wallets from meta walletMem`);
  return n;
}

// ---------- доказательства запуска ----------
// Кто выпустил токен (deployer), через какую фабрику, кто создал пул, транзакция выпуска, когда выпущен и когда
// рой его впервые увидел. Пишется при скане; известное поле не затирается пустым при пересканировании.
export interface Launch {
  token: string;
  chain: string;
  deployer: string | null;
  factory: string | null;
  poolCreator: string | null;
  tx: string | null;
  launchedAt: number | null;
  seenAt: number;
}
type LaunchRow = { token: string; chain: string; deployer: string | null; factory: string | null; pool_creator: string | null; tx: string | null; launched_at: number | null; seen_at: number };
const toLaunch = (r: LaunchRow): Launch => ({ token: r.token, chain: r.chain, deployer: r.deployer, factory: r.factory, poolCreator: r.pool_creator, tx: r.tx, launchedAt: r.launched_at, seenAt: r.seen_at });

export function putLaunch(d: Db, l: Omit<Launch, "seenAt"> & { seenAt?: number }) {
  d.db
    .prepare(
      `INSERT INTO launches (token, chain, deployer, factory, pool_creator, tx, launched_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (token) DO UPDATE SET deployer = COALESCE(excluded.deployer, deployer), factory = COALESCE(excluded.factory, factory),
       pool_creator = COALESCE(excluded.pool_creator, pool_creator), tx = COALESCE(excluded.tx, tx),
       launched_at = CASE WHEN excluded.tx IS NOT NULL AND excluded.launched_at IS NOT NULL THEN excluded.launched_at ELSE COALESCE(launched_at, excluded.launched_at) END`,
    )
    .run(l.token, l.chain, l.deployer, l.factory, l.poolCreator, l.tx, l.launchedAt, l.seenAt || Date.now());
}
export function launchOf(d: Db, token: string): Launch | null {
  const r = d.db.prepare("SELECT * FROM launches WHERE token = ?").get(token) as LaunchRow | undefined;
  return r ? toLaunch(r) : null;
}
export function launchesBy(d: Db, wallet: string, as: "deployer" | "factory"): Launch[] {
  return (d.db.prepare(`SELECT * FROM launches WHERE ${as} = ? ORDER BY seen_at DESC LIMIT 500`).all(wallet) as unknown as LaunchRow[]).map(toLaunch);
}
// Кошельки, записанные девом на многих токенах: кандидаты в фабрики (проверяются по коду контракта).
export function heavyDevs(d: Db, minTokens: number): { wallet: string; chain: string; n: number }[] {
  return d.db
    .prepare("SELECT wallet, MIN(chain) AS chain, COUNT(*) AS n FROM wallet_roles WHERE role = 'dev' GROUP BY wallet HAVING n >= ? ORDER BY n DESC LIMIT 200")
    .all(minTokens) as unknown as { wallet: string; chain: string; n: number }[];
}
// Переписать роль dev на factory у адреса-контракта; история (токены, время) сохраняется.
export function devToFactory(d: Db, wallet: string) {
  return Number(d.db.prepare("UPDATE wallet_roles SET role = 'factory' WHERE wallet = ? AND role = 'dev'").run(wallet).changes);
}
export const kvGet = (d: Db, k: string) => (d.db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined)?.v;
export const kvSet = (d: Db, k: string, v: string) => d.db.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").run(k, v);

// ---------- операторы между токенами ----------

export interface Operator {
  id: string;
  wallets: string[];
}
interface Ops {
  at: number;
  byWallet: Map<string, string>;
  byId: Map<string, Operator>;
}

// Кошельки, бывшие в одной группе на 2+ разных токенах, — одно ребро; компоненты связности — операторы.
// id — хэш наименьшего кошелька компоненты: стабилен, пока компонента не слилась с другой.
export function rebuildOperators(): Ops {
  const d = memDb();
  const empty: Ops = { at: Date.now(), byWallet: new Map(), byId: new Map() };
  if (!d) return (host.__crawlhiveOps = empty);
  try {
    const hubs = new Set(
      (d.db.prepare(`SELECT wallet FROM op_members GROUP BY wallet HAVING COUNT(DISTINCT token) > ${HUB_TOKENS}`).all() as { wallet: string }[]).map((r) => r.wallet),
    );
    const pairs = d.db
      .prepare(
        `SELECT a.wallet AS a, b.wallet AS b FROM op_members a JOIN op_members b ON a.token = b.token AND a.grp = b.grp AND a.wallet < b.wallet
         GROUP BY a.wallet, b.wallet HAVING COUNT(DISTINCT a.token) >= 2`,
      )
      .all() as { a: string; b: string }[];
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      while (parent.get(x) !== r) {
        const n = parent.get(x)!;
        parent.set(x, r);
        x = n;
      }
      return r;
    };
    for (const { a, b } of pairs) {
      if (hubs.has(a) || hubs.has(b)) continue;
      if (!parent.has(a)) parent.set(a, a);
      if (!parent.has(b)) parent.set(b, b);
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    }
    const comps = new Map<string, string[]>();
    for (const w of parent.keys()) comps.set(find(w), [...(comps.get(find(w)) ?? []), w]);
    const ops: Ops = { at: Date.now(), byWallet: new Map(), byId: new Map() };
    for (const [root, ws] of comps) {
      const id = `op_${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
      ops.byId.set(id, { id, wallets: ws.sort() });
      for (const w of ws) ops.byWallet.set(w, id);
    }
    host.__crawlhiveOps = ops;
    return ops;
  } catch (e) {
    console.warn("[memory] operators:", (e as Error).message);
    return (host.__crawlhiveOps = host.__crawlhiveOps ?? empty);
  }
}

export function operators(): Ops {
  const o = host.__crawlhiveOps;
  return o && Date.now() - o.at < OPS_EVERY + 60_000 ? o : rebuildOperators();
}

// Токены, на которых кошельки оператора были вместе в группе (а не просто где-то по отдельности).
export function operatorTokens(d: Db, wallets: string[]): { token: string; at: number }[] {
  return d.db
    .prepare("SELECT token, MIN(at) AS at FROM op_members WHERE wallet IN (SELECT value FROM json_each(?)) GROUP BY token")
    .all(JSON.stringify(wallets)) as { token: string; at: number }[];
}

// ---------- watchlist кошельков (Pro): кто за кем следит и о чём уже предупредили ----------

export interface WatchRow { owner: string; target: string; label: string; at: number }
export interface WatchAlert { owner: string; target: string; token: string; chain: string; role: string; at: number }

export function watchAdd(d: Db, owner: string, target: string, label: string) {
  d.db.prepare("INSERT INTO watch (owner, target, label, at) VALUES (?, ?, ?, ?) ON CONFLICT (owner, target) DO UPDATE SET label = excluded.label").run(owner, target, label, Date.now());
}
export const watchRemove = (d: Db, owner: string, target: string) => Number(d.db.prepare("DELETE FROM watch WHERE owner = ? AND target = ?").run(owner, target).changes) > 0;
export const watchList = (d: Db, owner: string) => d.db.prepare("SELECT owner, target, label, at FROM watch WHERE owner = ? ORDER BY at").all(owner) as unknown as WatchRow[];
export const watchCount = (d: Db, owner: string) => Number((d.db.prepare("SELECT COUNT(*) AS n FROM watch WHERE owner = ?").get(owner) as { n: number }).n);
// Кто следит за этими кошельками: один индексный запрос на весь скан.
export function watchersOf(d: Db, targets: string[]): WatchRow[] {
  if (!targets.length) return [];
  return d.db.prepare("SELECT owner, target, label, at FROM watch WHERE target IN (SELECT value FROM json_each(?))").all(JSON.stringify(targets)) as unknown as WatchRow[];
}
// true — алерт новый (пары владелец+кошелёк+токен ещё не было), false — уже предупреждали.
export function alertOnce(d: Db, a: Omit<WatchAlert, "at">) {
  return Number(d.db.prepare("INSERT OR IGNORE INTO watch_alerts (owner, target, token, chain, role, at) VALUES (?, ?, ?, ?, ?, ?)").run(a.owner, a.target, a.token, a.chain, a.role, Date.now()).changes) > 0;
}
export const recentAlerts = (d: Db, owner: string, limit = 30) =>
  d.db.prepare("SELECT owner, target, token, chain, role, at FROM watch_alerts WHERE owner = ? ORDER BY at DESC LIMIT ?").all(owner, limit) as unknown as WatchAlert[];

// ---------- watch операторов (Whale): следят за группой целиком, а не за кошельком ----------
// id оператора меняется, когда две группы сливаются, поэтому храним якорь — кошелёк-участник (наименьший в группе
// на момент добавления). Текущий оператор всегда находится по якорю, и новые участники группы попадают под watch сами.

export interface WatchOpRow { owner: string; anchor: string; op: string; label: string; at: number }
export interface WatchOpAlert { owner: string; anchor: string; op: string; token: string; chain: string; members: string; at: number }

export function watchOpAdd(d: Db, owner: string, anchor: string, op: string, label: string) {
  d.db.prepare("INSERT INTO watch_ops (owner, anchor, op, label, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner, anchor) DO UPDATE SET op = excluded.op, label = excluded.label").run(owner, anchor, op, label, Date.now());
}
export const watchOpRemove = (d: Db, owner: string, anchor: string) => Number(d.db.prepare("DELETE FROM watch_ops WHERE owner = ? AND anchor = ?").run(owner, anchor).changes) > 0;
export const watchOpList = (d: Db, owner: string) => d.db.prepare("SELECT owner, anchor, op, label, at FROM watch_ops WHERE owner = ? ORDER BY at").all(owner) as unknown as WatchOpRow[];
// Все watch операторов разом: таблица маленькая (до 25 на Whale), сверяется целиком после каждого скана.
export const watchOpAll = (d: Db) => d.db.prepare("SELECT owner, anchor, op, label, at FROM watch_ops").all() as unknown as WatchOpRow[];
export const watchOpAny = (d: Db) => !!d.db.prepare("SELECT 1 FROM watch_ops LIMIT 1").get();
// Запомнить последний известный id оператора (после слияния групп он другой).
export const watchOpTouch = (d: Db, owner: string, anchor: string, op: string) => d.db.prepare("UPDATE watch_ops SET op = ? WHERE owner = ? AND anchor = ?").run(op, owner, anchor);
// true — алерт по этому оператору и токену новый.
export function opAlertOnce(d: Db, a: Omit<WatchOpAlert, "at">) {
  return Number(d.db.prepare("INSERT OR IGNORE INTO watch_op_alerts (owner, anchor, op, token, chain, members, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(a.owner, a.anchor, a.op, a.token, a.chain, a.members, Date.now()).changes) > 0;
}
export const recentOpAlerts = (d: Db, owner: string, limit = 20) =>
  d.db.prepare("SELECT owner, anchor, op, token, chain, members, at FROM watch_op_alerts WHERE owner = ? ORDER BY at DESC LIMIT ?").all(owner, limit) as unknown as WatchOpAlert[];
