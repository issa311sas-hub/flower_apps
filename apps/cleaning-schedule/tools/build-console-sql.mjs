/**
 * migrations/*.sql から、Cloudflare の D1 Console に貼れる形のSQLを生成する。
 *
 * Console はコメントだけの断片や空文があると
 * 「Requests without any query are not supported」で落ちる。
 * そこでコメント・空行を落とし、種類ごとに分けたファイルを作る。
 *
 * 通常は `/setup` を開くだけでよく、これは保険。
 * 手書きせずここで生成するのは、migrations 本体とずれないようにするため。
 *
 *   node tools/build-console-sql.mjs          … 生成する
 *   node tools/build-console-sql.mjs --check  … 最新かどうかを確認する（テスト用）
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(ROOT, 'migrations');
const OUT_DIR = join(MIGRATIONS, 'console');

/** 行コメントを落として文単位に分割する（src/db/migrate.js と同じ規則） */
function splitStatements(sql) {
  return sql
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

const FILES = [
  {
    out: '01-tables.sql',
    title: 'テーブルの作成',
    match: (s) => /^CREATE\s+TABLE/i.test(s)
  },
  {
    out: '02-indexes.sql',
    title: 'インデックスの作成',
    match: (s) => /^CREATE\s+INDEX/i.test(s)
  },
  {
    out: '03-seed.sql',
    title: '初期データの投入',
    match: (s) => /^INSERT/i.test(s)
  },
  {
    // あとから足した列。01 のテーブル定義には入っていないので、別に流す必要がある
    out: '04-alters.sql',
    title: 'あとから足した列',
    match: (s) => /^ALTER\s+TABLE/i.test(s)
  }
];

export function buildConsoleSql() {
  // migrations/*.sql を全部読む。対象を書き並べると、
  // マイグレーションを足したときに黙って古くなる
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const statements = [];
  for (const file of files) {
    statements.push(...splitStatements(readFileSync(join(MIGRATIONS, file), 'utf8')));
  }

  const out = {};
  for (const spec of FILES) {
    const picked = statements.filter(spec.match);
    out[spec.out] = picked.map((s) => `${s};`).join('\n\n') + '\n';
  }

  const unmatched = statements.filter((s) => !FILES.some((f) => f.match(s)));
  return { files: out, unmatched };
}

function main() {
  const check = process.argv.includes('--check');
  const { files, unmatched } = buildConsoleSql();

  if (unmatched.length > 0) {
    console.error('どのファイルにも分類できない文があります:');
    for (const s of unmatched) console.error('  ' + s.slice(0, 80));
    process.exit(1);
  }

  if (!check) mkdirSync(OUT_DIR, { recursive: true });

  let stale = false;
  for (const [name, content] of Object.entries(files)) {
    const path = join(OUT_DIR, name);
    if (check) {
      const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
      if (current !== content) {
        console.error(`古くなっています: migrations/console/${name}`);
        stale = true;
      }
    } else {
      writeFileSync(path, content);
      console.log(`書き出しました: migrations/console/${name}`);
    }
  }

  if (check && stale) {
    console.error('`node tools/build-console-sql.mjs` を実行して更新してください。');
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
