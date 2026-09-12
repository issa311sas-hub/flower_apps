/**
 * 初回セットアップ（/setup）のテスト
 *
 * 実際の migrations/*.sql を読み込んで分割・適用し、
 * 「ブラウザでURLを開くだけでセットアップが終わる」動作を検証する。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../support/d1-sqlite.js';
import { splitSqlStatements, applyMigrations, getSchemaState, listPendingMigrations } from '../../src/db/migrate.js';
import { buildConsoleSql } from '../../tools/build-console-sql.mjs';
import { MIGRATIONS as MIGRATION_SOURCES } from '../../src/db/migrations.js';

const MIGRATIONS = new URL('../../migrations/', import.meta.url).pathname;
const read = (name) => readFileSync(join(MIGRATIONS, name), 'utf8');

/** 本番と同じ一覧を使う（テストだけ古くなることを防ぐ） */
const SOURCES = MIGRATION_SOURCES;

/** 初期スキーマと初期データだけ（途中まで進んだDBの再現に使う） */
const BASE_SOURCES = SOURCES.slice(0, 2);

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
    expect(result.state.tableCount).toBe(15);
  });

  it('作られたデータが正しい', async () => {
    await applyMigrations(db, SOURCES);

    const units = await db.prepare('SELECT name FROM units ORDER BY sort_order').all();
    expect(units.results.map((r) => r.name)).toEqual(['b4', 'b5', 'b6', 'b2', 'b3', 's1', 's2', 's3', 'c4']);

    const staff = await db.prepare('SELECT name FROM staff ORDER BY priority').all();
    expect(staff.results.map((r) => r.name)).toEqual(['細田さん', '普久原さん', '福田さん', 'Rクリーン']);
  });

  it('SQLite/D1 が自動で作る管理用の表は数に入れない', async () => {
    // 本番の D1 には、アプリが作っていない管理用の表が存在する。
    // これを数に入れると「テーブル15個のはずが16個ある」と不安にさせるため除外する。
    await db.prepare('CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB)').run();
    await db.prepare('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT)').run();

    await applyMigrations(db, SOURCES);
    const state = await getSchemaState(db);

    expect(state.tableCount).toBe(15);
    expect(state.tables).not.toContain('_cf_KV');
    expect(state.tables).not.toContain('d1_migrations');
    expect(state.internalTables).toEqual(expect.arrayContaining(['_cf_KV', 'd1_migrations']));
  });

  it('AUTOINCREMENT で生まれる sqlite_sequence も数に入れない', async () => {
    await applyMigrations(db, SOURCES);
    // staff への INSERT で sqlite_sequence が作られている
    const state = await getSchemaState(db);

    expect(state.internalTables).toContain('sqlite_sequence');
    expect(state.tableCount).toBe(15);
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
    expect(state.tableCount).toBe(15);
  });
});

describe('あとからマイグレーションを足す', () => {
  const SOURCE_0003 = { name: '0003_extra.sql', sql: 'CREATE TABLE extra (id INTEGER PRIMARY KEY);' };

  it('未適用のものだけを流す', async () => {
    await applyMigrations(db, SOURCES);

    const result = await applyMigrations(db, [...SOURCES, SOURCE_0003]);

    expect(result.applied).toBe(true);
    expect(result.executed.map((e) => e.name)).toEqual(['0003_extra.sql']);
    expect(result.state.tables).toContain('extra');
  });

  it('すでに動いているDB（記録が無い）にも足せる', async () => {
    // この仕組みを入れる前のDBを再現する（テーブルはあるが schema_migrations が無い）
    const legacy = createTestDb({ applyMigrations: false });
    for (const source of BASE_SOURCES) {
      await legacy.batch(splitSqlStatements(source.sql).map((sql) => legacy.prepare(sql)));
    }

    const result = await applyMigrations(legacy, [...BASE_SOURCES, SOURCE_0003]);

    // 0001/0002 は流し直さず「適用済み」として引き継ぐ
    expect(result.executed.map((e) => e.name)).toEqual(['0003_extra.sql']);
    expect(result.alreadyApplied).toEqual(['0001_init.sql', '0002_seed_master.sql']);

    // 初期データが二重に入っていないこと
    expect(Number(await legacy.prepare('SELECT COUNT(*) AS n FROM units').first('n'))).toBe(9);
  });

  it('テーブルだけあって初期データが無いDBでは、初期データだけを流す', async () => {
    const noSeed = createTestDb({ seed: false });
    await noSeed.prepare('DROP TABLE IF EXISTS schema_migrations').run();

    const result = await applyMigrations(noSeed, BASE_SOURCES);

    expect(result.executed.map((e) => e.name)).toEqual(['0002_seed_master.sql']);
    expect(result.state.unitCount).toBe(9);
  });

  it('何度呼んでも二度は流さない', async () => {
    await applyMigrations(db, [...SOURCES, SOURCE_0003]);
    const second = await applyMigrations(db, [...SOURCES, SOURCE_0003]);

    expect(second.applied).toBe(false);
    expect(second.executed).toEqual([]);
  });

  it('未適用のものを一覧できる（動作確認画面で使う）', async () => {
    await applyMigrations(db, SOURCES);

    expect(await listPendingMigrations(db, [...SOURCES, SOURCE_0003])).toEqual(['0003_extra.sql']);
    expect(await listPendingMigrations(db, SOURCES)).toEqual([]);
  });

  it('記録用の表はアプリの表として数えない', async () => {
    await applyMigrations(db, SOURCES);
    const state = await getSchemaState(db);

    expect(state.tables).not.toContain('schema_migrations');
    expect(state.internalTables).toContain('schema_migrations');
  });
});

describe('マイグレーションの一覧', () => {
  it('migrations/ の中身と src/db/migrations.js が一致している', () => {
    // 足したのに一覧に書き忘れると、本番に永久に反映されない。ここで気づけるようにする
    const onDisk = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    expect(MIGRATION_SOURCES.map((m) => m.name)).toEqual(onDisk);
  });

  it('順番どおりに並んでいる', () => {
    const names = MIGRATION_SOURCES.map((m) => m.name);
    expect(names).toEqual([...names].sort());
  });
});
