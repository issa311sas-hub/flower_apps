/**
 * 認証（Cookie とセッション、CSRF対策）
 *
 * 設計の要点:
 *   - スタッフ用の処理は**リクエストから staff_id を受け取らない**。必ずセッションから引く。
 *     これで「他人のデータに触れない」がコードの構造として保証される
 *   - Cookie には乱数だけを入れ、DBにはそのハッシュを保存する
 *   - CSRF は SameSite=Lax と Origin 検証の2段構え
 */

import { getSessionUser, SESSION_DAYS } from '../db/users.js';
import { redirect } from './html.js';

export const COOKIE_NAME = 'sid';

export function parseCookies(request) {
  const header = request.headers.get('cookie') ?? '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/**
 * ログイン状態を保つ Cookie。
 * Max-Age を付ける（＝永続Cookie）ので、スマホを再起動しても保持される。
 * セッションCookieにすると毎回ログインが必要になり、スタッフには負担が大きい。
 */
export function sessionCookie(token) {
  const maxAge = SESSION_DAYS * 24 * 3600;
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Cookie からログイン中のユーザーを取得する（いなければ null） */
export async function getCurrentUser(request, env, options = {}) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (!token) return null;
  return getSessionUser(env.DB, token, { pepper: env.SESSION_PEPPER ?? '', at: options.at });
}

/**
 * ログインを要求する。
 * 未ログインならログイン画面へ、権限が足りなければ自分のページへ戻す。
 *
 * @returns {{user: object}|{response: Response}}
 */
export async function requireUser(request, env, { role = null, at = undefined } = {}) {
  const user = await getCurrentUser(request, env, { at });
  if (!user) {
    const url = new URL(request.url);
    const next = encodeURIComponent(url.pathname + url.search);
    return { response: redirect(`/login?next=${next}`) };
  }

  if (role && user.role !== role) {
    return { response: redirect(user.role === 'admin' ? '/admin' : '/me') };
  }

  // 初回ログイン時はパスワード変更を終えるまで他の画面に進ませない
  const path = new URL(request.url).pathname;
  if (user.mustChange && path !== '/me/password' && path !== '/logout') {
    return { response: redirect('/me/password') };
  }

  return { user };
}

/**
 * CSRF 対策の Origin 検証。
 *
 * SameSite=Lax だけでもフォーム送信のCSRFはほぼ防げるが、
 * 念のため Origin（無ければ Referer）が自分自身であることを確認する。
 * ヘッダが無い場合も拒否する（古いブラウザより安全側に倒す）。
 */
export function checkOrigin(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return true;

  const target = new URL(request.url).origin;
  const origin = request.headers.get('origin');
  if (origin) return origin === target;

  const referer = request.headers.get('referer');
  if (referer) {
    try {
      return new URL(referer).origin === target;
    } catch {
      return false;
    }
  }
  return false;
}

/** フォームの内容を素直なオブジェクトにする（同名の項目は配列にまとめる） */
export async function readForm(request) {
  const form = await request.formData();
  const out = {};
  for (const [key, value] of form.entries()) {
    if (key in out) {
      out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** 同名の項目を必ず配列で取り出す */
export function formList(form, key) {
  const value = form[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
