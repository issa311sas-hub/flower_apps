/**
 * スタッフ画面のテスト
 *
 * 出勤入力はこの移行の成否を決める画面なので、
 * 「入れた値が確実に残る」「他人の分を触れない」を重点的に確認する。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/index.js';
import { createTestDb } from '../support/d1-sqlite.js';
import { createUser } from '../../src/db/users.js';
import { getStaffByName } from '../../src/db/staff.js';
import { listForStaff, getCapacityMap } from '../../src/db/availability.js';
import { saveAssignments, listAssignments } from '../../src/db/assignments.js';
import { applyFetchedBookings } from '../../src/db/bookings.js';

const ORIGIN = 'https://cleaning.example.workers.dev';
const PEPPER = 'test-pepper';
const FAST = { pepper: PEPPER, iterations: 1000 };

let env;
beforeEach(() => {
  env = { DB: createTestDb(), SESSION_PEPPER: PEPPER };
});

function get(path, cookie) {
  return new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
}

function post(path, body, cookie) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
      ...(cookie ? { cookie } : {})
    },
    body: new URLSearchParams(body).toString()
  });
}

async function loginAs(loginId, staffName) {
  const staff = staffName ? await getStaffByName(env.DB, staffName) : null;
  const created = await createUser(
    env.DB,
    {
      loginId,
      displayName: staffName ?? '管理者',
      role: staff ? 'staff' : 'admin',
      staffId: staff?.id ?? null,
      mustChange: false
    },
    FAST
  );

  const res = await worker.fetch(post('/login', { login_id: loginId, password: created.password }), env);
  const cookie = (res.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0];
  return { cookie, staff, userId: created.id };
}

describe('出勤入力', () => {
  it('入力した件数が保存され、開き直しても残っている', async () => {
    const { cookie, staff } = await loginAs('hosoda', '細田さん');

    const res = await worker.fetch(
      post(
        '/me/availability',
        { month: '2099-01', 'cap_2099-01-10': '3', 'cap_2099-01-11': '0', 'cap_2099-01-12': '2' },
        cookie
      ),
      env
    );

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('saved=1');

    expect(await listForStaff(env.DB, staff.id, { from: '2099-01-01', to: '2099-01-31' })).toEqual({
      '2099-01-10': 3,
      '2099-01-11': 0,
      '2099-01-12': 2
    });
  });

  it('保存した値が割り当てエンジンに渡る形で読める', async () => {
    const { cookie } = await loginAs('hosoda', '細田さん');
    await worker.fetch(post('/me/availability', { month: '2099-01', 'cap_2099-01-10': '3' }, cookie), env);

    const map = await getCapacityMap(env.DB, { from: '2099-01-01', to: '2099-01-31' });
    expect(map['細田さん']['2099-01-10']).toBe(3);
  });

  it('0〜9以外の値は保存しない', async () => {
    const { cookie, staff } = await loginAs('hosoda', '細田さん');

    await worker.fetch(
      post(
        '/me/availability',
        { month: '2099-01', 'cap_2099-01-10': '99', 'cap_2099-01-11': 'abc', 'cap_2099-01-12': '-1' },
        cookie
      ),
      env
    );

    expect(await listForStaff(env.DB, staff.id, { from: '2099-01-01', to: '2099-01-31' })).toEqual({});
  });

  it('過去の日付は変更できない', async () => {
    const { cookie, staff } = await loginAs('hosoda', '細田さん');

    await worker.fetch(post('/me/availability', { month: '2020-01', 'cap_2020-01-10': '3' }, cookie), env);

    expect(await listForStaff(env.DB, staff.id, { from: '2020-01-01', to: '2020-01-31' })).toEqual({});
  });

  it('他人の出勤可否は書き換えられない（自分の分として保存される）', async () => {
    const hosoda = await loginAs('hosoda', '細田さん');
    const fukuhara = await getStaffByName(env.DB, '普久原さん');

    // staff_id を送りつけても無視され、ログイン中の本人の分になる
    await worker.fetch(
      post(
        '/me/availability',
        { month: '2099-01', staff_id: String(fukuhara.id), 'cap_2099-01-10': '5' },
        hosoda.cookie
      ),
      env
    );

    expect(await listForStaff(env.DB, fukuhara.id, { from: '2099-01-01', to: '2099-01-31' })).toEqual({});
    expect(await listForStaff(env.DB, hosoda.staff.id, { from: '2099-01-01', to: '2099-01-31' })).toEqual({
      '2099-01-10': 5
    });
  });

  it('画面に未入力の日数が表示される', async () => {
    const { cookie } = await loginAs('hosoda', '細田さん');
    const res = await worker.fetch(get('/me/availability?month=2099-01', cookie), env);
    const body = await res.text();

    // 入力漏れがそのまま外注コストになるため、未入力であることを画面で伝える
    expect(body).toContain('入力がない日は「出勤できない（0件）」として扱われます');
    expect(body).toContain('<strong>31日</strong> 未入力');
  });
});

/** 報告フォームの最小の入力（項目は 0003 の初期値） */
function reportBody(extra = {}) {
  return {
    condition: 'B',
    equipment_FireStick: 'ok',
    equipment_電気: 'ok',
    equipment_エアコン: 'ok',
    equipment_キッチンガス: 'ok',
    'equipment_お風呂のお湯': 'ok',
    equipment_iPad: 'ok',
    'service_バーベキュー': 'none',
    'service_海遊び': 'none',
    settlement: '0',
    ...extra
  };
}

describe('自分の予定', () => {
  async function seedAssignment(staffName, { bookingId = '1', unit = 'b4', date = '2099-01-10' } = {}) {
    await applyFetchedBookings(
      env.DB,
      [
        {
          bookingId,
          title: '消毒ポット',
          startDate: '2099-01-05',
          checkoutDate: date,
          unit,
          guests: 2
        }
      ],
      { from: '2099-01-01', to: '2099-12-31' },
      '2099-01-01T00:00:00Z'
    );

    await saveAssignments(
      env.DB,
      [
        {
          bookingId,
          checkoutDate: date,
          cleaningDate: date,
          unit,
          title: '消毒ポット',
          staffName,
          status: '確定',
          guests: 2,
          isManual: false
        }
      ],
      { nextGuests: { [bookingId]: 3 } }
    );
  }

  it('自分の担当だけが表示される', async () => {
    const { cookie } = await loginAs('hosoda', '細田さん');
    await seedAssignment('細田さん', { bookingId: '1', unit: 'b4' });
    await seedAssignment('普久原さん', { bookingId: '2', unit: 's1' });

    const res = await worker.fetch(get('/me?from=2099-01-01', cookie), env);
    const body = await res.text();

    // 期間外なので今日の予定は出ないが、他人の分が混ざらないことを確認する
    expect(body).not.toContain('s1');
  });

  it('自分の担当なら報告フォームを開ける', async () => {
    const { cookie } = await loginAs('hosoda', '細田さん');
    await seedAssignment('細田さん');

    const form = await worker.fetch(get('/me/report/1', cookie), env);
    expect(form.status).toBe(200);

    const body = await form.text();
    expect(body).toContain('完了報告');
    expect(body).toContain('現地精算金額');
  });

  it('報告すると完了になる', async () => {
    const { cookie, userId } = await loginAs('hosoda', '細田さん');
    await seedAssignment('細田さん');

    const res = await worker.fetch(post('/me/report/1', reportBody(), cookie), env);
    expect(res.status).toBe(303);

    const rows = await listAssignments(env.DB);
    expect(rows[0].completedAt).toBeTruthy();

    const completedBy = await env.DB.prepare('SELECT completed_by FROM assignments WHERE booking_id = ?')
      .bind('1')
      .first('completed_by');
    expect(completedBy).toBe(userId);
  });

  it('報告を取り消せる', async () => {
    const { cookie } = await loginAs('hosoda', '細田さん');
    await seedAssignment('細田さん');

    await worker.fetch(post('/me/report/1', reportBody(), cookie), env);
    await worker.fetch(post('/me/report/1/undo', {}, cookie), env);

    const rows = await listAssignments(env.DB);
    expect(rows[0].completedAt).toBeNull();
  });

  it('他人の担当は報告できない', async () => {
    const { cookie } = await loginAs('hosoda', '細田さん');
    await seedAssignment('普久原さん', { bookingId: '9' });

    expect((await worker.fetch(get('/me/report/9', cookie), env)).status).toBe(404);
    expect((await worker.fetch(post('/me/report/9', reportBody(), cookie), env)).status).toBe(404);

    const rows = await listAssignments(env.DB);
    expect(rows[0].completedAt).toBeNull();
  });
});

describe('管理者によるアカウント管理', () => {
  it('スタッフを追加するとパスワードが1回だけ表示される', async () => {
    const { cookie } = await loginAs('owner', null);
    const staff = await getStaffByName(env.DB, '細田さん');

    const res = await worker.fetch(
      post('/admin/staff', { login_id: 'hosoda', display_name: '細田さん', staff_id: String(staff.id) }, cookie),
      env
    );
    const body = await res.text();

    expect(body).toContain('パスワードを発行しました');
    expect(body).toContain('hosoda');

    const created = await env.DB.prepare("SELECT role, staff_id, must_change FROM users WHERE login_id = 'hosoda'").first();
    expect(created.role).toBe('staff');
    expect(created.staff_id).toBe(staff.id);
    expect(created.must_change).toBe(1); // 初回はパスワード変更を求める
  });

  it('同じIDは追加できない', async () => {
    const { cookie } = await loginAs('owner', null);
    const staff = await getStaffByName(env.DB, '細田さん');
    const body = { login_id: 'hosoda', display_name: '細田さん', staff_id: String(staff.id) };

    await worker.fetch(post('/admin/staff', body, cookie), env);
    const res = await worker.fetch(post('/admin/staff', body, cookie), env);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('すでに使われています');
  });

  it('パスワードを再発行すると、古いパスワードでは入れなくなる', async () => {
    const { cookie } = await loginAs('owner', null);
    const staff = await getStaffByName(env.DB, '細田さん');

    const createRes = await worker.fetch(
      post('/admin/staff', { login_id: 'hosoda', display_name: '細田さん', staff_id: String(staff.id) }, cookie),
      env
    );
    const oldPassword = (await createRes.text()).match(/id="issued" type="text" value="([^"]+)"/)[1];

    const userId = await env.DB.prepare("SELECT id FROM users WHERE login_id = 'hosoda'").first('id');
    await worker.fetch(post(`/admin/staff/${userId}/password`, {}, cookie), env);

    const login = await worker.fetch(post('/login', { login_id: 'hosoda', password: oldPassword }), env);
    expect(login.status).toBe(401);
  });

  it('停止するとログインできなくなる', async () => {
    const { cookie } = await loginAs('owner', null);
    const staff = await getStaffByName(env.DB, '細田さん');

    const createRes = await worker.fetch(
      post('/admin/staff', { login_id: 'hosoda', display_name: '細田さん', staff_id: String(staff.id) }, cookie),
      env
    );
    const password = (await createRes.text()).match(/id="issued" type="text" value="([^"]+)"/)[1];
    const userId = await env.DB.prepare("SELECT id FROM users WHERE login_id = 'hosoda'").first('id');

    await worker.fetch(post(`/admin/staff/${userId}/active`, { active: '0' }, cookie), env);

    const login = await worker.fetch(post('/login', { login_id: 'hosoda', password }), env);
    expect(login.status).toBe(401);
  });

  it('自分自身は停止できない（管理者が居なくなるのを防ぐ）', async () => {
    const { cookie, userId } = await loginAs('owner', null);

    await worker.fetch(post(`/admin/staff/${userId}/active`, { active: '0' }, cookie), env);

    const row = await env.DB.prepare('SELECT is_active FROM users WHERE id = ?').bind(userId).first();
    expect(row.is_active).toBe(1);
  });
});
