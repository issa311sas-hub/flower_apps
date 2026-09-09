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

/** いま DB がどういう状態かを調べる */
export async function getSchemaState(db) {
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();

  const tableNames = tables.results.map((r) => r.name);
  const state = {
    tables: tableNames,
    tableCount: tableNames.length,
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
 * マイグレーションを適用する。
 *
 * **空のDBに対してしか動かない。** すでに初期データが入っている場合は何もせず、
 * 現状を返すだけにする。第三者が叩いても既存データを壊せないようにするため。
 *
 * @param {object} db D1 データベース
 * @param {Array<{name: string, sql: string}>} sources 適用するSQL（順番どおりに実行する）
 */
export async function applyMigrations(db, sources) {
  const before = await getSchemaState(db);

  if (before.isSeeded) {
    return { applied: false, reason: 'already_setup', state: before };
  }

  const executed = [];
  for (const source of sources) {
    const statements = splitSqlStatements(source.sql);
    if (statements.length === 0) continue;

    // スキーマ作成済みで初期データだけ入っていない場合、CREATE TABLE は流さない
    const skipCreates = before.hasSchema && statements.some((s) => /^CREATE\s+TABLE/i.test(s));
    const toRun = skipCreates ? statements.filter((s) => !/^CREATE\s+(TABLE|INDEX)/i.test(s)) : statements;
    if (toRun.length === 0) continue;

    await db.batch(toRun.map((sql) => db.prepare(sql)));
    executed.push({ name: source.name, statements: toRun.length });
  }

  const after = await getSchemaState(db);
  return { applied: true, executed, state: after };
}
