/**
 * ログインユーザーとセッション
 *
 * 方針:
 *   - パスワードは PBKDF2 + サーバー側の秘密（ペッパー）でハッシュ化して保存する
 *   - セッションは Cookie に乱数を置き、DBには**ハッシュだけ**保存する
 *     （DBが漏れても、そこからログインはできない）
 *   - 総当たり対策として、失敗回数が続いたら一時的にロックする
 */

import { nowIso } from '../core/dates.js';
import {
  hashPassword,
  verifyPassword,
  randomToken,
  sha256Hex,
  generatePassword,
  DEFAULT_PBKDF2_ITERATIONS
} from '../integrations/crypto.js';

/** ログイン失敗が続いたときのロック */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 10;

/** セッションの有効期間（スマホを再起動しても保持されるよう長めに取る） */
export const SESSION_DAYS = 180;

export { generatePassword };

function toUser(row) {
  return {
    id: row.id,
    loginId: row.login_id,
    displayName: row.display_name,
    role: row.role,
    staffId: row.staff_id,
    mustChange: row.must_change === 1,
    isActive: row.is_active === 1,
    lastLoginAt: row.last_login_at
  };
}

export async function listUsers(db) {
  const { results } = await db
    .prepare(
      `SELECT u.*, s.name AS staff_name
         FROM users u LEFT JOIN staff s ON s.id = u.staff_id
        ORDER BY u.role DESC, u.id`
    )
    .all();
  return results.map((r) => ({ ...toUser(r), staffName: r.staff_name }));
}

export async function getUserById(db, id) {
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  return row ? toUser(row) : null;
}

export async function getUserByLoginId(db, loginId) {
  const row = await db.prepare('SELECT * FROM users WHERE login_id = ?').bind(String(loginId).trim()).first();
  return row ? toUser(row) : null;
}

export async function countUsers(db) {
  return Number((await db.prepare('SELECT COUNT(*) AS n FROM users').first('n')) ?? 0);
}

/**
 * ユーザーを作る。パスワードを省略すると自動生成し、平文を返す。
 * 平文はここでしか手に入らない（DBにはハッシュしか残らない）。
 */
export async function createUser(db, user, { pepper = '', iterations = DEFAULT_PBKDF2_ITERATIONS, at = nowIso() } = {}) {
  const password = user.password ?? generatePassword();
  const stored = await hashPassword(password, { iterations, pepper });

  const result = await db
    .prepare(
      `INSERT INTO users
         (login_id, display_name, role, staff_id, password_iterations, password_salt, password_hash,
          must_change, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .bind(
      String(user.loginId).trim(),
      user.displayName,
      user.role,
      user.staffId ?? null,
      stored.iterations,
      stored.salt,
      stored.hash,
      user.mustChange === false ? 0 : 1,
      at,
      at
    )
    .run();

  return { id: result.meta.last_row_id, password };
}

/** パスワードを再発行する（管理者の操作、または本人の変更） */
export async function setPassword(
  db,
  userId,
  password,
  { pepper = '', iterations = DEFAULT_PBKDF2_ITERATIONS, mustChange = false, at = nowIso() } = {}
) {
  const stored = await hashPassword(password, { iterations, pepper });
  await db
    .prepare(
      `UPDATE users
          SET password_iterations = ?, password_salt = ?, password_hash = ?,
              must_change = ?, failed_attempts = 0, locked_until = NULL, updated_at = ?
        WHERE id = ?`
    )
    .bind(stored.iterations, stored.salt, stored.hash, mustChange ? 1 : 0, at, userId)
    .run();
}

export async function setUserActive(db, userId, isActive, at = nowIso()) {
  await db
    .prepare('UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?')
    .bind(isActive ? 1 : 0, at, userId)
    .run();
  // 無効にしたら、その人のセッションも切る
  if (!isActive) await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}

/**
 * ログインを検証する。
 * 失敗の理由は画面には出さない（IDの存在有無を推測されないようにするため）。
 */
export async function verifyLogin(db, loginId, password, { pepper = '', at = nowIso() } = {}) {
  const row = await db.prepare('SELECT * FROM users WHERE login_id = ?').bind(String(loginId).trim()).first();
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.is_active !== 1) return { ok: false, reason: 'inactive' };

  if (row.locked_until && Date.parse(row.locked_until) > Date.parse(at)) {
    return { ok: false, reason: 'locked', lockedUntil: row.locked_until };
  }

  const matched = await verifyPassword(
    password,
    { salt: row.password_salt, hash: row.password_hash, iterations: row.password_iterations },
    { pepper }
  );

  if (!matched) {
    const attempts = (row.failed_attempts ?? 0) + 1;
    const lockedUntil =
      attempts >= MAX_FAILED_ATTEMPTS
        ? new Date(Date.parse(at) + LOCK_MINUTES * 60 * 1000).toISOString()
        : null;

    await db
      .prepare('UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?')
      .bind(attempts, lockedUntil, at, row.id)
      .run();

    return { ok: false, reason: lockedUntil ? 'locked' : 'bad_password', lockedUntil };
  }

  await db
    .prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?')
    .bind(at, at, row.id)
    .run();

  return { ok: true, user: toUser(row) };
}

// ------------------------------------------------------------------
// セッション
// ------------------------------------------------------------------

/** Cookie に入れる生のトークンを返す。DBにはそのハッシュだけを保存する */
export async function createSession(db, userId, { pepper = '', at = nowIso(), userAgent = null } = {}) {
  const token = randomToken(32);
  const id = await sha256Hex(token + pepper);
  const expiresAt = new Date(Date.parse(at) + SESSION_DAYS * 24 * 3600 * 1000).toISOString();

  await db
    .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, userId, at, expiresAt, at, userAgent ? String(userAgent).slice(0, 300) : null)
    .run();

  return { token, expiresAt };
}

/**
 * Cookie のトークンからユーザーを引く。
 * 期限切れ・無効化されたユーザーは弾く。
 * しばらくアクセスがあった場合は期限を延長する（使い続けている限りログインが切れない）。
 */
export async function getSessionUser(db, token, { pepper = '', at = nowIso() } = {}) {
  if (!token) return null;
  const id = await sha256Hex(token + pepper);

  const row = await db
    .prepare(
      `SELECT s.id AS sid, s.expires_at, s.last_seen_at, u.*
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`
    )
    .bind(id)
    .first();

  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.parse(at)) return null;
  if (row.is_active !== 1) return null;

  // 1日以上経っていれば期限を延ばす（毎回書き込むとD1への負荷が無駄に増えるため）
  if (Date.parse(at) - Date.parse(row.last_seen_at) > 24 * 3600 * 1000) {
    const expiresAt = new Date(Date.parse(at) + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
    await db
      .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .bind(at, expiresAt, row.sid)
      .run();
  }

  return toUser(row);
}

export async function deleteSession(db, token, { pepper = '' } = {}) {
  if (!token) return;
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(token + pepper)).run();
}
