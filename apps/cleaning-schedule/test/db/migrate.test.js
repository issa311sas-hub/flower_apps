/**
 * 初回セットアップ（/setup）のテスト
 *
 * 実際の migrations/*.sql を読み込んで分割・適用し、
 * 「ブラウザでURLを開くだけでセットアップが終わる」動作を検証する。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../support/d1-sqlite.js';
import { splitSqlStatements, applyMigrations, getSchemaState } from '../../src/db/migrate.js';
import { buildConsoleSql } from '../../tools/build-console-sql.mjs';

const MIGRATIONS = new URL('../../migrations/', import.meta.url).pathname;
const read = (name) => readFileSync(join(MIGRATIONS, name), 'utf8');

const SOURCES = [
  { name: '0001_init.sql', sql: read('0001_init.sql') },
  { name: '0002_seed_master.sql', sql: read('0002_seed_master.sql') }
];

let db;
beforeEach(() => {
  // seed:false で「マイグレーション未適用の空のDB」を作る
  db = createTestDb({ applyMigrations: false });
});

describe('SQLの分割', () => {
  it('行コメントを落とす', () => {
    const out = splitSqlStatements('-- これはコメント\nSELECT 1;');
    expect(out).toEqual(['SELECT 1']);
  });

  it('コメントだけなら空になる（Consoleが落ちていた原因）', () => {
    expect(splitSqlStatements('-- コメントのみ\n--\n\n')).toEqual([]);
  });

  it('末尾のセミコロンの後ろに空文を作らない', () => {
    expect(splitSqlStatements('SELECT 1;\nSELECT 2;\n')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('行の途中から始まるコメントも落とす', () => {
    expect(splitSqlStatements('SELECT 1; -- 説明\nSELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('実際のマイグレーションを分割できる', () => {
    const init = splitSqlStatements(read('0001_init.sql'));
    expect(init.length).toBeGreaterThan(20);
    expect(init.every((s) => s.length > 0)).toBe(true);
    // コメントだけの断片が残っていないこと
    expect(init.some((s) => s.startsWith('--'))).toBe(false);
  });
});

describe('初回セットアップ', () => {
  it('空のDBにテーブルと初期データを作る', async () => {
    const result = await applyMigrations(db, SOURCES);

    expect(result.applied).toBe(true);
    expect(result.state.hasSchema).toBe(true);
    expect(result.state.unitCount).toBe(9);
    expect(result.state.staffCount).toBe(4);
    expect(result.state.tableCount).toBe(13);
  });

  it('作られたデータが正しい', async () => {
    await applyMigrations(db, SOURCES);

    const units = await db.prepare('SELECT name FROM units ORDER BY sort_order').all();
    expect(units.results.map((r) => r.name)).toEqual(['b4', 'b5', 'b6', 'b2', 'b3', 's1', 's2', 's3', 'c4']);

    const staff = await db.prepare('SELECT name FROM staff ORDER BY priority').all();
    expect(staff.results.map((r) => r.name)).toEqual(['細田さん', '普久原さん', '福田さん', 'Rクリーン']);
  });

  it('2回実行しても壊れない（何もしない）', async () => {
    await applyMigrations(db, SOURCES);
    const second = await applyMigrations(db, SOURCES);

    expect(second.applied).toBe(false);
    expect(second.reason).toBe('already_setup');
    expect(second.state.unitCount).toBe(9);
    expect(second.state.staffCount).toBe(4);
  });

  it('既存データがあるDBを上書きしない', async () => {
    await applyMigrations(db, SOURCES);
    await db.prepare("UPDATE staff SET default_capacity = 5 WHERE name = '細田さん'").run();

    await applyMigrations(db, SOURCES);

    const cap = await db.prepare("SELECT default_capacity AS c FROM staff WHERE name = '細田さん'").first('c');
    expect(cap).toBe(5);
  });

  it('テーブルだけあって初期データがない状態から復旧できる', async () => {
    // 途中まで手作業で流してしまった場合を想定
    await db.batch(splitSqlStatements(read('0001_init.sql')).map((s) => db.prepare(s)));
    expect((await getSchemaState(db)).isSeeded).toBe(false);

    const result = await applyMigrations(db, SOURCES);

    expect(result.applied).toBe(true);
    expect(result.state.unitCount).toBe(9);
    expect(result.state.staffCount).toBe(4);
  });
});

describe('Console用SQL（保険）', () => {
  it('生成物が最新の migrations と一致している', () => {
    const { files, unmatched } = buildConsoleSql();
    expect(unmatched).toEqual([]);

    for (const [name, content] of Object.entries(files)) {
      const committed = readFileSync(join(MIGRATIONS, 'console', name), 'utf8');
      expect(committed, `migrations/console/${name} が古い。node tools/build-console-sql.mjs を実行すること`).toBe(content);
    }
  });

  it('生成物にコメントも空文も含まれない', () => {
    const { files } = buildConsoleSql();
    for (const [name, content] of Object.entries(files)) {
      expect(content.includes('--'), `${name} にコメントが残っている`).toBe(false);
      const statements = content.split(';').map((s) => s.trim()).filter(Boolean);
      expect(statements.length).toBeGreaterThan(0);
    }
  });

  it('Console用SQLを順に流してもセットアップできる', async () => {
    const { files } = buildConsoleSql();
    for (const name of ['01-tables.sql', '02-indexes.sql', '03-seed.sql']) {
      await db.batch(splitSqlStatements(files[name]).map((s) => db.prepare(s)));
    }

    const state = await getSchemaState(db);
    expect(state.unitCount).toBe(9);
    expect(state.staffCount).toBe(4);
    expect(state.tableCount).toBe(13);
  });
});
