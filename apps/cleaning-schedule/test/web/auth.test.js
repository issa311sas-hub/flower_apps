/**
 * ログインとセッションのテスト
 *
 * Worker の fetch を直接呼び、実際のHTTPのやり取りとして検証する。
 * 特に「他人のデータに触れない」ことは、設計上の約束なので必ず確認する。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/index.js';
import { createTestDb } from '../support/d1-sqlite.js';
import { createUser, verifyLogin, MAX_FAILED_ATTEMPTS } from '../../src/db/users.js';
import { getStaffByName } from '../../src/db/staff.js';

const ORIGIN = 'https://cleaning.example.workers.dev';
const PEPPER = 'test-pepper';
const ENC_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

let env;
beforeEach(() => {
  env = { DB: createTestDb(), SESSION_PEPPER: PEPPER, TOKEN_ENC_KEY: ENC_KEY };
});

/** テスト用に反復回数を落とす（本番の既定値だとテストが遅くなるため） */
const FAST = { pepper: PEPPER, iterations: 1000 };

function get(path, { cookie } = {}) {
  return new Request(`${ORIGIN}${path}`, {
    headers: cookie ? { cookie } : {}
  });
}

function post(path, body, { cookie, origin = ORIGIN } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (cookie) headers.cookie = cookie;
  if (origin !== null) headers.origin = origin;

  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body).toString()
  });
}

/** Set-Cookie から sid を取り出す */
function cookieFrom(response) {
  const header = response.headers.get('set-cookie') ?? '';
  const match = header.match(/sid=([^;]+)/);
  return match ? `sid=${match[1]}` : null;
}

async function login(loginId, password) {
  const res = await worker.fetch(post('/login', { login_id: loginId, password }), env);
  return { res, cookie: cookieFrom(res) };
}

async function seedAdmin() {
  const created = await createUser(
    env.DB,
    { loginId: 'owner', displayName: '経営者', role: 'admin', mustChange: false },
    FAST
  );
  return { loginId: 'owner', password: created.password, id: created.id };
}

async function seedStaff(loginId, staffName) {
  const staff = await getStaffByName(env.DB, staffName);
  const created = await createUser(
    env.DB,
    { loginId, displayName: staffName, role: 'staff', staffId: staff.id, mustChange: false },
    FAST
  );
  return { loginId, password: created.password, staffId: staff.id, id: created.id };
}

describe('ログイン', () => {
  it('正しいID・パスワードでログインできる', async () => {
    const admin = await seedAdmin();
    const { res, cookie } = await login(admin.loginId, admin.password);

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin');
    expect(cookie).toBeTruthy();
  });

  it('Cookie は HttpOnly / Secure / SameSite=Lax で、端末を再起動しても残る', async () => {
    const admin = await seedAdmin();
    const { res } = await login(admin.loginId, admin.password);
    const header = res.headers.get('set-cookie');

    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toMatch(/Max-Age=\d{6,}/); // 永続Cookie（セッションCookieではない）
  });

  it('パスワードが違えばログインできない', async () => {
    const admin = await seedAdmin();
    const { res, cookie } = await login(admin.loginId, 'wrong-password');

    expect(res.status).toBe(401);
    expect(cookie).toBeNull();
  });

  it('存在しないIDでも、パスワード違いと同じ見た目にする（IDの存在を推測させない）', async () => {
    await seedAdmin();
    const notFound = await login('nobody', 'x');
    const wrongPw = await login('owner', 'x');

    expect(notFound.res.status).toBe(wrongPw.res.status);
    expect(await notFound.res.text()).toContain('IDまたはパスワードが違います');
  });

  it('失敗が続くとロックされ、正しいパスワードでも入れなくなる', async () => {
    const admin = await seedAdmin();

    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await login(admin.loginId, 'wrong');
    }

    const { res } = await login(admin.loginId, admin.password);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('ロック');
  });

  it('停止されたアカウントはログインできない', async () => {
    const admin = await seedAdmin();
    await env.DB.prepare('UPDATE users SET is_active = 0 WHERE id = ?').bind(admin.id).run();

    const { res } = await login(admin.loginId, admin.password);
    expect(res.status).toBe(401);
  });

  it('ログアウトするとCookieが消え、画面に入れなくなる', async () => {
    const admin = await seedAdmin();
    const { cookie } = await login(admin.loginId, admin.password);

    const out = await worker.fetch(post('/logout', {}, { cookie }), env);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');

    const after = await worker.fetch(get('/admin', { cookie }), env);
    expect(after.headers.get('location')).toContain('/login');
  });
});

describe('アクセス制御', () => {
  it('未ログインだとログイン画面に送られる', async () => {
    const res = await worker.fetch(get('/me'), env);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('ログイン後に元のページへ戻る', async () => {
    const staff = await seedStaff('hosoda', '細田さん');
    const res = await worker.fetch(get('/me/availability'), env);
    expect(res.headers.get('location')).toBe('/login?next=%2Fme%2Favailability');

    const login = await worker.fetch(
      post('/login', { login_id: staff.loginId, password: staff.password, next: '/me/availability' }),
      env
    );
    expect(login.headers.get('location')).toBe('/me/availability');
  });

  it('スタッフは管理画面に入れない', async () => {
    const staff = await seedStaff('hosoda', '細田さん');
    const { cookie } = await login(staff.loginId, staff.password);

    const res = await worker.fetch(get('/admin', { cookie }), env);
    expect(res.headers.get('location')).toBe('/me');
  });

  it('スタッフは他人のアカウントを作れない', async () => {
    const staff = await seedStaff('hosoda', '細田さん');
    const { cookie } = await login(staff.loginId, staff.password);

    const res = await worker.fetch(
      post('/admin/staff', { login_id: 'evil', display_name: 'x' }, { cookie }),
      env
    );
    expect(res.headers.get('location')).toBe('/me');

    const users = await env.DB.prepare("SELECT login_id FROM users WHERE login_id = 'evil'").all();
    expect(users.results).toHaveLength(0);
  });

  it('初回ログイン時はパスワード変更まで他の画面に進めない', async () => {
    const staff = await getStaffByName(env.DB, '細田さん');
    const created = await createUser(
      env.DB,
      { loginId: 'newbie', displayName: '新人', role: 'staff', staffId: staff.id },
      FAST
    );

    const { res, cookie } = await login('newbie', created.password);
    expect(res.headers.get('location')).toBe('/me/password');

    const blocked = await worker.fetch(get('/me', { cookie }), env);
    expect(blocked.headers.get('location')).toBe('/me/password');
  });

  it('期限切れのセッションでは入れない', async () => {
    const admin = await seedAdmin();
    const { cookie } = await login(admin.loginId, admin.password);

    await env.DB.prepare("UPDATE sessions SET expires_at = '2020-01-01T00:00:00Z'").run();

    const res = await worker.fetch(get('/admin', { cookie }), env);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('でたらめなCookieでは入れない', async () => {
    await seedAdmin();
    const res = await worker.fetch(get('/admin', { cookie: 'sid=deadbeef' }), env);
    expect(res.headers.get('location')).toContain('/login');
  });
});

describe('CSRF対策', () => {
  it('Origin が無いPOSTは拒否する', async () => {
    const staff = await seedStaff('hosoda', '細田さん');
    const { cookie } = await login(staff.loginId, staff.password);

    const res = await worker.fetch(
      post('/me/availability', { month: '2026-09' }, { cookie, origin: null }),
      env
    );
    expect(res.status).toBe(403);
  });

  it('別サイトからのPOSTは拒否する', async () => {
    const staff = await seedStaff('hosoda', '細田さん');
    const { cookie } = await login(staff.loginId, staff.password);

    const res = await worker.fetch(
      post('/me/availability', { month: '2026-09' }, { cookie, origin: 'https://evil.example.com' }),
      env
    );
    expect(res.status).toBe(403);
  });
});

describe('パスワードの保存', () => {
  it('DBには平文もペッパー無しのハッシュも残らない', async () => {
    const created = await createUser(
      env.DB,
      { loginId: 'x', displayName: 'x', role: 'admin', password: 'my-secret-password' },
      FAST
    );

    const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(created.id).first();
    expect(JSON.stringify(row)).not.toContain('my-secret-password');

    // ペッパーが違えば照合できない（DBだけ盗まれても入れない）
    const wrongPepper = await verifyLogin(env.DB, 'x', 'my-secret-password', { pepper: 'different' });
    expect(wrongPepper.ok).toBe(false);

    const rightPepper = await verifyLogin(env.DB, 'x', 'my-secret-password', { pepper: PEPPER });
    expect(rightPepper.ok).toBe(true);
  });

  it('セッションの生トークンはDBに保存されない', async () => {
    const admin = await seedAdmin();
    const { cookie } = await login(admin.loginId, admin.password);
    const token = cookie.slice('sid='.length);

    const rows = await env.DB.prepare('SELECT id FROM sessions').all();
    expect(rows.results[0].id).not.toBe(decodeURIComponent(token));
  });
});

describe('初回セットアップでの管理者作成', () => {
  it('ユーザーが居なければ管理者を作り、パスワードを1回だけ表示する', async () => {
    const fresh = { DB: createTestDb({ applyMigrations: false }), SESSION_PEPPER: PEPPER };
    await fresh.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('password_iterations', '1000', 'x')")
      .run()
      .catch(() => {}); // テーブルがまだ無い場合は無視（/setup が作る）

    const res = await worker.fetch(get('/setup'), fresh);
    const body = await res.text();

    expect(body).toContain('管理者アカウントを作成しました');
    expect(body).toContain('admin');

    const count = await fresh.DB.prepare('SELECT COUNT(*) AS n FROM users').first('n');
    expect(Number(count)).toBe(1);
  });

  it('2回目は管理者を作り直さず、ログインを求める', async () => {
    // 管理者が居る＝運用が始まっている。DBの状態を誰にでも見せない
    const fresh = { DB: createTestDb({ applyMigrations: false }), SESSION_PEPPER: PEPPER };
    await worker.fetch(get('/setup'), fresh);

    const second = await worker.fetch(get('/setup'), fresh);
    expect(second.status).toBe(303);
    expect(second.headers.get('location')).toContain('/login');

    const count = await fresh.DB.prepare('SELECT COUNT(*) AS n FROM users').first('n');
    expect(Number(count)).toBe(1);
  });

  it('管理者でログインしていれば、2回目も進み具合を確認できる', async () => {
    const admin = await seedAdmin();
    const { cookie } = await login(admin.loginId, admin.password);

    const res = await worker.fetch(get('/setup', { cookie }), env);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain('セットアップはすでに完了しています');
    expect(body).toContain('Beds24 につなぐ');
  });

  it('スタッフは初回セットアップの画面に入れない', async () => {
    await seedAdmin();
    const staff = await seedStaff('hosoda', '細田さん');
    const { cookie } = await login(staff.loginId, staff.password);

    const res = await worker.fetch(get('/setup', { cookie }), env);
    expect(res.headers.get('location')).toBe('/me');
  });
});

describe('秘密の鍵の画面', () => {
  it('登録済みなら鍵を作り直さない', async () => {
    const res = await worker.fetch(get('/setup/keys'), env);
    const body = await res.text();

    expect(body).toContain('2つとも登録済みです');
    expect(body).toContain('鍵を作り直さないでください');
    expect(body).not.toContain('id="SESSION_PEPPER"');
  });

  it('未登録の鍵だけを生成し、/setup への案内を出す', async () => {
    const res = await worker.fetch(get('/setup/keys'), { DB: env.DB });
    const body = await res.text();

    expect(body).toContain('id="SESSION_PEPPER"');
    expect(body).toContain('id="TOKEN_ENC_KEY"');
    // /setup と間違えやすいので、必ず行き先を示す
    expect(body).toContain('この画面は「秘密の鍵を作る」専用です');
    expect(body).toContain('href="/setup"');
  });
});
