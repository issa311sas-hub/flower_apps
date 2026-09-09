/**
 * ログイン / ログアウト
 */

import { html, page, htmlResponse, redirect, raw } from '../html.js';
import { checkOrigin, readForm, sessionCookie, clearCookie, parseCookies, COOKIE_NAME } from '../auth.js';
import { verifyLogin, createSession, deleteSession, LOCK_MINUTES } from '../../db/users.js';

function loginPage({ error = null, loginId = '', next = '' } = {}) {
  return page({
    title: 'ログイン',
    nav: false,
    body: html`
      <h2>ログイン</h2>
      ${raw(error ? `<div class="banner error">${error}</div>` : '')}
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${next}">
        <label for="login_id">ID</label>
        <input id="login_id" name="login_id" value="${loginId}" autocomplete="username"
               autocapitalize="none" autocorrect="off" required>

        <label for="password">パスワード</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>

        <p style="margin-top:20px"><button type="submit" class="primary">ログイン</button></p>
      </form>
      <p class="small muted">パスワードが分からない場合は、管理者に連絡してください。</p>
    `
  });
}

export function showLogin(request) {
  const next = new URL(request.url).searchParams.get('next') ?? '';
  return htmlResponse(loginPage({ next }));
}

export async function doLogin(request, env) {
  if (!checkOrigin(request)) {
    return htmlResponse(loginPage({ error: '送信元を確認できませんでした。もう一度お試しください。' }), { status: 403 });
  }

  const form = await readForm(request);
  const loginId = String(form.login_id ?? '').trim();
  const password = String(form.password ?? '');
  const next = String(form.next ?? '');

  const result = await verifyLogin(env.DB, loginId, password, { pepper: env.SESSION_PEPPER ?? '' });

  if (!result.ok) {
    // IDが存在するかどうかを推測されないよう、理由は区別せずに返す
    const message =
      result.reason === 'locked'
        ? `ログインの失敗が続いたため、${LOCK_MINUTES}分間ロックされています。時間をおいてお試しください。`
        : 'IDまたはパスワードが違います。';
    return htmlResponse(loginPage({ error: message, loginId, next }), { status: 401 });
  }

  const { token } = await createSession(env.DB, result.user.id, {
    pepper: env.SESSION_PEPPER ?? '',
    userAgent: request.headers.get('user-agent')
  });

  const destination = result.user.mustChange
    ? '/me/password'
    : next && next.startsWith('/')
      ? next
      : result.user.role === 'admin'
        ? '/admin'
        : '/me';

  return redirect(destination, { headers: { 'set-cookie': sessionCookie(token) } });
}

export async function doLogout(request, env) {
  const token = parseCookies(request)[COOKIE_NAME];
  await deleteSession(env.DB, token, { pepper: env.SESSION_PEPPER ?? '' });
  return redirect('/login', { headers: { 'set-cookie': clearCookie() } });
}
