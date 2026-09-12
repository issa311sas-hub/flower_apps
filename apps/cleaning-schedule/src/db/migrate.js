/**
 * 初回セットアップ（テーブル作成と初期データ投入）
 *
 * Cloudflare のダッシュボードの Console に長いSQLを貼る手順は、
 * コメントだけの断片や空文が混じると
 * 「Requests without any query are not supported」で落ちるうえ、
 * 初めて触る人には負担が大きい。
 * そこで `/setup` を開くだけで済むようにする。
 *
 * スキーマの正は `migrations/*.sql` のまま。ここでは実行時にそれを
 * 文単位に分割して適用するだけで、スキーマ定義を二重に持たない。
 */

/**
 * SQL をステートメント単位に分割する。
 *
 * 行コメント（`--`）を落とし、`;` で区切り、空文を捨てる。
 *
 * ⚠ 前提: 文字列リテラルの中に `;` や `--` を含む文は扱えない。
 *    現在の migrations にはそのような文はない。将来入れる場合はここを直すこと。
 */
export function splitSqlStatements(sql) {
  return String(sql)
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 適用済みマイグレーションを記録する表の名前（定義は下） */
const MIGRATIONS_TABLE_NAME = 'schema_migrations';

/**
 * アプリのデータではない、管理用の表。
 *
 *   sqlite_*          … SQLite が自動で作る（AUTOINCREMENT を使うと sqlite_sequence ができる）
 *   _cf_*             … D1 が内部で使う
 *   d1_*              … wrangler の migrations 機能が使う（d1_migrations）
 *   schema_migrations … このアプリが適用済みマイグレーションを覚えておくために作る
 *
 * ローカルのテスト環境（node:sqlite）と本番の D1 では、これらの有無が違う。
 * 数が合わないと「壊れているのでは」と不安になるため、アプリの表だけを数える。
 */
const INTERNAL_TABLE_PREFIXES = ['sqlite_', '_cf_', 'd1_'];
const INTERNAL_TABLES = [MIGRATIONS_TABLE_NAME];

const isInternalTable = (name) =>
  INTERNAL_TABLES.includes(name) || INTERNAL_TABLE_PREFIXES.some((p) => name.startsWith(p));

/** いま DB がどういう状態かを調べる */
export async function getSchemaState(db) {
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all();

  const allNames = tables.results.map((r) => r.name);
  const tableNames = allNames.filter((n) => !isInternalTable(n));
  const state = {
    tables: tableNames,
    tableCount: tableNames.length,
    internalTables: allNames.filter(isInternalTable),
    hasSchema: tableNames.includes('staff') && tableNames.includes('units'),
    staffCount: 0,
    unitCount: 0
  };

  if (state.hasSchema) {
    state.staffCount = Number((await db.prepare('SELECT COUNT(*) AS n FROM staff').first('n')) ?? 0);
    state.unitCount = Number((await db.prepare('SELECT COUNT(*) AS n FROM units').first('n')) ?? 0);
  }

  state.isSeeded = state.hasSchema && state.staffCount > 0 && state.unitCount > 0;
  return state;
}

/**
 * 適用済みマイグレーションを覚えておく表。
 *
 * これが無いと、すでに動いているDBに新しいテーブルを足せない
 * （以前は「初期データが入っていたら何もしない」設計だった）。
 */
export const MIGRATIONS_TABLE = MIGRATIONS_TABLE_NAME;

/**
 * この仕組みを入れる前から動いていたDB向けの引き継ぎ。
 *
 * 本番DBにはすでに 0001 / 0002 が流れているが、記録が無い。
 * そのまま流し直すと「テーブルが既にある」で落ちるので、
 * 現物を見て「適用済み」として記録だけ書き込む。
 */
const BASELINE = [
  { name: '0001_init.sql', appliedIf: (state) => state.hasSchema },
  { name: '0002_seed_master.sql', appliedIf: (state) => state.isSeeded }
];

async function ensureMigrationsTable(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
         name       TEXT PRIMARY KEY,
         applied_at TEXT NOT NULL
       )`
    )
    .run();
}

/** 適用済みの名前（昇順） */
export async function listAppliedMigrations(db) {
  await ensureMigrationsTable(db);
  const { results } = await db.prepare(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name`).all();
  return results.map((r) => r.name);
}

/** まだ流していないマイグレーション（順番どおり） */
export async function listPendingMigrations(db, sources) {
  const applied = new Set(await listAppliedMigrations(db));
  return sources.filter((s) => !applied.has(s.name)).map((s) => s.name);
}

/**
 * マイグレーションを適用する。
 *
 * **未適用のものだけ**を順に流し、適用したことを記録する。
 * すでに流したものは二度と実行しないので、何度呼んでも安全。
 *
 * @param {object} db D1 データベース
 * @param {Array<{name: string, sql: string}>} sources 適用するSQL（順番どおりに実行する）
 */
export async function applyMigrations(db, sources, { at = new Date().toISOString() } = {}) {
  const before = await getSchemaState(db);
  await ensureMigrationsTable(db);

  const applied = new Set(await listAppliedMigrations(db));

  // 記録が1つも無いなら、この仕組みを入れる前のDB。現物を見て引き継ぐ
  if (applied.size === 0) {
    for (const base of BASELINE) {
      if (!base.appliedIf(before)) continue;
      await db
        .prepare(`INSERT OR IGNORE INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`)
        .bind(base.name, at)
        .run();
      applied.add(base.name);
    }
  }

  const executed = [];
  for (const source of sources) {
    if (applied.has(source.name)) continue;

    const statements = splitSqlStatements(source.sql);
    if (statements.length > 0) await db.batch(statements.map((sql) => db.prepare(sql)));

    await db
      .prepare(`INSERT OR IGNORE INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`)
      .bind(source.name, at)
      .run();

    executed.push({ name: source.name, statements: statements.length });
  }

  const after = await getSchemaState(db);
  return {
    applied: executed.length > 0,
    reason: executed.length > 0 ? null : 'already_setup',
    executed,
    alreadyApplied: [...applied].sort(),
    state: after
  };
}
