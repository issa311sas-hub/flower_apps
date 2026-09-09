/**
 * テスト用の D1 互換アダプタ
 *
 * Cloudflare D1 は SQLite なので、Node 標準の `node:sqlite` の上に
 * D1 と同じ形のAPI（prepare / bind / first / all / run / batch）をかぶせる。
 * これでデータ層のテストが、実際のスキーマと実際の SQL に対して走る。
 * 依存パッケージも Cloudflare も不要。
 *
 * 対応しているのは本アプリが使う範囲のみ。D1 の完全な再現ではない。
 */

import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// `node:sqlite` は Vite の依存解決を通すと読めないため、実行時に require で取り込む
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url).pathname;

class Statement {
  constructor(db, sql, values = []) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new Statement(this.db, this.sql, values);
  }

  #prepared() {
    return this.db.prepare(this.sql);
  }

  async first(column) {
    const row = this.#prepared().get(...this.values);
    if (row === undefined) return null;
    const plain = { ...row };
    return column === undefined ? plain : (plain[column] ?? null);
  }

  async all() {
    const rows = this.#prepared().all(...this.values).map((r) => ({ ...r }));
    return { success: true, results: rows, meta: { rows_read: rows.length } };
  }

  async run() {
    const info = this.#prepared().run(...this.values);
    return {
      success: true,
      meta: {
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0)
      }
    };
  }
}

class TestD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  prepare(sql) {
    return new Statement(this.db, sql);
  }

  async batch(statements) {
    // D1 の batch は暗黙のトランザクション。ここでも同じ扱いにする。
    this.db.exec('BEGIN');
    try {
      const out = [];
      for (const stmt of statements) out.push(await stmt.run());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async exec(sql) {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }
}

/**
 * テスト用DBを作る
 *
 * @param {{seed?: boolean, applyMigrations?: boolean}} [options]
 *   applyMigrations=false … 何も適用しない空のDB（/setup のテスト用）
 *   seed=false            … テーブルだけ作り、初期データ（0002）は入れない
 */
export function createTestDb(options = {}) {
  const seed = options.seed ?? true;
  const apply = options.applyMigrations ?? true;
  const d1 = new TestD1();

  if (!apply) return d1;

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (!seed && file.startsWith('0002')) continue;
    d1.db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }

  return d1;
}
