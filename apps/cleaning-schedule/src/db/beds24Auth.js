/**
 * Beds24 の認証情報（1行だけのテーブル）
 *
 * 旧 GAS 版の PropertiesService（BEDS24_REFRESH_TOKEN 等）の置き換え。
 * トークンは暗号化して保存する（鍵は Secret の TOKEN_ENC_KEY）。
 *
 * リフレッシュトークンは使うたびにローテーションされ、
 * 30日間使われないと失効する。最後に使えた日時（last_ok_at）を記録し、
 * 失効が近づいたら警告できるようにしている（旧 v8 の設計を踏襲）。
 */

import { nowIso } from '../core/dates.js';
import { encryptSecret, decryptSecret } from '../integrations/crypto.js';

export const STATE = {
  DISCONNECTED: '未接続',
  CONNECTED: '接続済み',
  NEEDS_RECONNECT: '要再接続',
  ERROR: '接続エラー'
};

/** リフレッシュトークンが失効するまでの日数（Beds24 の仕様） */
export const REFRESH_TOKEN_EXPIRE_DAYS = 30;
/** 失効の何日前から警告するか */
export const TOKEN_WARN_DAYS = 20;

async function readRow(db) {
  return db.prepare('SELECT * FROM beds24_auth WHERE id = 1').first();
}

/** 画面表示用の状態（トークンそのものは返さない） */
export async function getAuthStatus(db, nowMs = Date.now()) {
  const row = await readRow(db);
  if (!row) {
    return { state: STATE.DISCONNECTED, hasToken: false, lastOkAt: null, daysSinceOk: null, lastError: null };
  }

  const lastOkAt = row.last_ok_at || null;
  const daysSinceOk = lastOkAt
    ? Math.floor((nowMs - Date.parse(lastOkAt)) / (24 * 3600 * 1000))
    : null;

  return {
    state: row.state,
    hasToken: !!row.refresh_token_enc,
    lastOkAt,
    daysSinceOk,
    daysUntilExpiry: daysSinceOk === null ? null : Math.max(0, REFRESH_TOKEN_EXPIRE_DAYS - daysSinceOk),
    needsWarning: daysSinceOk !== null && daysSinceOk >= TOKEN_WARN_DAYS,
    lastError: row.last_error || null,
    updatedAt: row.updated_at
  };
}

export async function getRefreshToken(db, encKey) {
  const row = await readRow(db);
  if (!row || !row.refresh_token_enc) return null;
  return decryptSecret(row.refresh_token_enc, encKey);
}

/** 有効期限内のアクセストークンがあれば返す（なければ null） */
export async function getCachedAccessToken(db, encKey, nowMs = Date.now()) {
  const row = await readRow(db);
  if (!row || !row.access_token_enc || !row.access_expires_at) return null;

  // 期限の1分前を過ぎていたら使わない（旧版と同じ余裕の取り方）
  if (nowMs >= Date.parse(row.access_expires_at) - 60000) return null;
  return decryptSecret(row.access_token_enc, encKey);
}

export async function saveTokens(db, encKey, { refreshToken, accessToken, expiresInSec }, at = nowIso()) {
  const fields = [];
  const values = [];

  if (refreshToken !== undefined) {
    fields.push('refresh_token_enc = ?');
    values.push(refreshToken === null ? null : await encryptSecret(refreshToken, encKey));
  }
  if (accessToken !== undefined) {
    fields.push('access_token_enc = ?');
    values.push(accessToken === null ? null : await encryptSecret(accessToken, encKey));

    fields.push('access_expires_at = ?');
    values.push(
      accessToken === null ? null : new Date(Date.parse(at) + (expiresInSec ?? 86400) * 1000).toISOString()
    );
  }

  fields.push('last_ok_at = ?', 'state = ?', 'last_error = NULL', 'updated_at = ?');
  values.push(at, STATE.CONNECTED, at);

  await db.prepare(`UPDATE beds24_auth SET ${fields.join(', ')} WHERE id = 1`).bind(...values).run();
}

/**
 * 接続できなくなったことを記録する。
 *
 * 401/403（失効・取り消し）とそれ以外（一時的な障害）を区別するのは旧 v8 と同じ。
 * 一時的な障害でトークンを捨ててしまうと、復旧できるものまで再接続が必要になるため。
 */
export async function recordAuthFailure(db, { permanent, error }, at = nowIso()) {
  await db
    .prepare('UPDATE beds24_auth SET state = ?, last_error = ?, updated_at = ? WHERE id = 1')
    .bind(permanent ? STATE.NEEDS_RECONNECT : STATE.ERROR, String(error).slice(0, 500), at)
    .run();
}

/** 接続を解除する（トークンを消す） */
export async function clearTokens(db, at = nowIso()) {
  await db
    .prepare(
      `UPDATE beds24_auth
          SET refresh_token_enc = NULL, access_token_enc = NULL, access_expires_at = NULL,
              state = ?, updated_at = ?
        WHERE id = 1`
    )
    .bind(STATE.DISCONNECTED, at)
    .run();
}
