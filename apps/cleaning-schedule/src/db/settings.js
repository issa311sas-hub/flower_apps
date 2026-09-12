/**
 * 設定（旧 設定シート）の読み書き
 */

import { nowIso } from '../core/dates.js';
import { sha256Hex } from '../integrations/crypto.js';

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

// ------------------------------------------------------------------
// SESSION_PEPPER の指紋
// ------------------------------------------------------------------

/**
 * パスワードは SESSION_PEPPER を混ぜてハッシュ化している。
 * この値が登録時と変わると、**正しいパスワードでも誰もログインできなくなる**。
 * しかも画面には「IDまたはパスワードが違います」としか出ず、原因にたどり着けない。
 *
 * そこで、どの鍵で作られたパスワードなのかを見分けられるように指紋を残す。
 * 残すのは 32バイト乱数の SHA-256 なので、ここから鍵は復元できない。
 */
export const PEPPER_FINGERPRINT_KEY = 'pepper_fingerprint';

export async function recordPepperFingerprint(db, pepper, at = nowIso()) {
  await setSetting(db, PEPPER_FINGERPRINT_KEY, await sha256Hex(String(pepper ?? '')), at);
}

/**
 * @returns {{known: boolean, matches: boolean}}
 *   known=false は「まだ記録がない」。この場合は判定できないので matches=true を返す。
 */
export async function checkPepperFingerprint(db, pepper) {
  const stored = await getSetting(db, PEPPER_FINGERPRINT_KEY, '');
  if (!stored) return { known: false, matches: true };
  return { known: true, matches: stored === (await sha256Hex(String(pepper ?? ''))) };
}
