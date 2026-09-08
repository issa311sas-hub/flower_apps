/**
 * 設定（旧 設定シート）の読み書き
 */

import { nowIso } from '../core/dates.js';

const NUMERIC_KEYS = new Set([
  'fetch_days',
  'outsource_window_days',
  'max_defer_days',
  'stale_run_alert_days'
]);

/** すべての設定を { key: value } で返す（数値項目は数値に変換する） */
export async function getSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const row of results) {
    out[row.key] = NUMERIC_KEYS.has(row.key) ? Number(row.value) : row.value;
  }
  return out;
}

export async function getSetting(db, key, fallback = null) {
  const value = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first('value');
  if (value === null || value === undefined) return fallback;
  return NUMERIC_KEYS.has(key) ? Number(value) : value;
}

export async function setSetting(db, key, value, at = nowIso()) {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, String(value), at)
    .run();
}

/** まとめて更新する（管理画面の設定フォーム用） */
export async function setSettings(db, values, at = nowIso()) {
  const entries = Object.entries(values);
  if (entries.length === 0) return;

  await db.batch(
    entries.map(([key, value]) =>
      db
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .bind(key, String(value), at)
    )
  );
}

/** 割り当てエンジンに渡すパラメータを設定から組み立てる */
export async function getAssignParams(db) {
  const s = await getSettings(db);
  return {
    maxDeferDays: s.max_defer_days ?? 2,
    outsourceWindowDays: s.outsource_window_days ?? 14
  };
}
