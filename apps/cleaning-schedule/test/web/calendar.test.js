/**
 * 出勤入力のカレンダー画面のテスト
 *
 * この画面が使えるかどうかで移行の成否が決まるので、
 * 「カレンダーと一覧入力で保存結果が食い違わないこと」を重点的に確認する。
 * 送信されるのはどちらも cap_YYYY-MM-DD なので、そこがずれたら片方が壊れる。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/index.js';
import { createTestDb } from '../support/d1-sqlite.js';
import { createUser } from '../../src/db/users.js';
import { getStaffByName } from '../../src/db/staff.js';
import { listForStaff } from '../../src/db/availability.js';

const ORIGIN = 'https://cleaning.example.workers.dev';
const PEPPER = 'test-pepper';
const FAST = { pepper: PEPPER, iterations: 1000 };
const MONTH = '2099-01';
const RANGE = { from: '2099-01-01', to: '2099-01-31' };

let env;
let cookie;
let staffId;

beforeEach(async () => {
  env = { DB: createTestDb(), SESSION_PEPPER: PEPPER };

  const staff = await getStaffByName(env.DB, '細田さん');
  staffId = staff.id;

  const created = await createUser(
    env.DB,
    { loginId: 'hosoda', displayName: '細田さん', role: 'staff', staffId: staff.id, mustChange: false },
    FAST
  );
  const res = await worker.fetch(post('/login', { login_id: 'hosoda', password: created.password }), env);
  cookie = (res.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0];
});

function get(path) {
  return new Request(`${ORIGIN}${path}`, { headers: { cookie } });
}

function post(path, body, { cookie: cookieValue } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN };
  if (cookieValue) headers.cookie = cookieValue;
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body).toString()
  });
}

const save = (body) => worker.fetch(post('/me/availability', body, { cookie }), env);
const show = async (path) => (await worker.fetch(get(path), env)).text();

describe('画面の切り替え', () => {
  it('既定はカレンダー', async () => {
    const body = await show(`/me/availability?month=${MONTH}`);

    expect(body).toContain('class="calendar"');
    expect(body).toContain('id="cal-picker"');
    expect(body).not.toContain('class="avail-list"');
  });

  it('?view=list で一覧入力に切り替わる', async () => {
    const body = await show(`/me/availability?month=${MONTH}&view=list`);

    expect(body).toContain('class="avail-list"');
    expect(body).not.toContain('class="calendar"');
  });

  it('どちらの画面からも、もう一方に行ける', async () => {
    const calendar = await show(`/me/availability?month=${MONTH}`);
    expect(calendar).toContain(`href="/me/availability?month=${MONTH}&view=list"`);

    const list = await show(`/me/availability?month=${MONTH}&view=list`);
    expect(list).toContain(`href="/me/availability?month=${MONTH}"`);
  });

  it('注意書きはどちらの画面にも出る', async () => {
    for (const path of [`/me/availability?month=${MONTH}`, `/me/availability?month=${MONTH}&view=list`]) {
      const body = await show(path);
      expect(body).toContain('入力がない日は「出勤できない（0件）」として扱われます');
      expect(body).toContain('<strong>31日</strong> 未入力');
    }
  });

  it('保存したあとも、開いていた画面のまま戻る', async () => {
    const calendar = await save({ month: MONTH, view: 'calendar', 'cap_2099-01-10': '1' });
    expect(calendar.headers.get('location')).not.toContain('view=list');

    const list = await save({ month: MONTH, view: 'list', 'cap_2099-01-11': '1' });
    expect(list.headers.get('location')).toContain('view=list');
  });
});

describe('カレンダーの組み立て', () => {
  it('月初の曜日まで空セルが入る', async () => {
    // 2099-01-01 は木曜（日曜起点で4番目）なので、前に4つ空セルが入る
    const body = await show(`/me/availability?month=${MONTH}`);
    const blanks = body.match(/<div class="cal-blank"><\/div>/g) ?? [];

    expect(blanks).toHaveLength(4);
    expect(body).toContain('<div class="cal-head sun">日</div>');
    expect(body).toContain('<div class="cal-head sat">土</div>');
  });

  it('日数ぶんのマスがあり、それぞれに日付が入っている', async () => {
    const body = await show(`/me/availability?month=${MONTH}`);
    const cells = body.match(/data-day="2099-01-\d\d"/g) ?? [];

    expect(cells).toHaveLength(31);
    expect(body).toContain('data-day="2099-01-01"');
    expect(body).toContain('data-day="2099-01-31"');
  });

  it('入力済みの日はマスに件数が出る', async () => {
    await save({ month: MONTH, 'cap_2099-01-10': '3' });
    const body = await show(`/me/availability?month=${MONTH}`);

    expect(body).toMatch(/data-day="2099-01-10"[\s\S]*?<span class="cal-value">3<\/span>/);
  });

  it('未入力の未来日に目印が付く', async () => {
    const body = await show(`/me/availability?month=${MONTH}`);
    expect(body).toMatch(/class="cal-cell[^"]*unset[^"]*" data-day="2099-01-10"/);
  });

  it('過去の日は押せない印が付き、送信されても無視される', async () => {
    const body = await show('/me/availability?month=2020-01');

    expect(body).toContain('data-past="1"');
    expect(body).toContain('disabled');

    await save({ month: '2020-01', 'cap_2020-01-10': '3' });
    expect(await listForStaff(env.DB, staffId, { from: '2020-01-01', to: '2020-01-31' })).toEqual({});
  });

  it('JavaScript が動かない端末には一覧入力を案内する', async () => {
    const body = await show(`/me/availability?month=${MONTH}`);

    expect(body).toContain('<noscript>');
    expect(body).toContain('「一覧入力」に切り替えてください');
  });
});

describe('カレンダーと一覧入力で結果が一致する', () => {
  it('同じ内容を送れば同じように保存される', async () => {
    await save({ month: MONTH, view: 'calendar', 'cap_2099-01-10': '3', 'cap_2099-01-11': '0' });
    const fromCalendar = await listForStaff(env.DB, staffId, RANGE);

    await save({ month: MONTH, view: 'list', 'cap_2099-01-10': '3', 'cap_2099-01-11': '0' });
    const fromList = await listForStaff(env.DB, staffId, RANGE);

    expect(fromCalendar).toEqual({ '2099-01-10': 3, '2099-01-11': 0 });
    expect(fromList).toEqual(fromCalendar);
  });

  it('カレンダーのマスも一覧の行も、同じ入力欄を持っている', async () => {
    const calendar = await show(`/me/availability?month=${MONTH}`);
    const list = await show(`/me/availability?month=${MONTH}&view=list`);

    for (const body of [calendar, list]) {
      expect(body).toContain('name="cap_2099-01-10" value="3"');
    }
  });
});

describe('未入力に戻す', () => {
  it('「消す」を送るとその日が未入力に戻る', async () => {
    await save({ month: MONTH, 'cap_2099-01-10': '3' });
    expect(await listForStaff(env.DB, staffId, RANGE)).toEqual({ '2099-01-10': 3 });

    await save({ month: MONTH, 'cap_2099-01-10': '-1' });
    expect(await listForStaff(env.DB, staffId, RANGE)).toEqual({});
  });

  it('0件の入力とは別物として扱う', async () => {
    await save({ month: MONTH, 'cap_2099-01-10': '0', 'cap_2099-01-11': '2' });
    await save({ month: MONTH, 'cap_2099-01-11': '-1' });

    // 0件は残り、消した日だけが未入力に戻る
    expect(await listForStaff(env.DB, staffId, RANGE)).toEqual({ '2099-01-10': 0 });
  });

  it('カレンダーのマスに「消す」の選択肢がある', async () => {
    const body = await show(`/me/availability?month=${MONTH}`);

    expect(body).toContain('name="cap_2099-01-10" value="-1"');
    expect(body).toContain('data-value="-1">消す</button>');
  });

  it('過去の日は消せない', async () => {
    const staff = await getStaffByName(env.DB, '細田さん');
    await env.DB.prepare(
      "INSERT INTO availability (staff_id, date, capacity, updated_at) VALUES (?, '2020-01-10', 2, 'x')"
    )
      .bind(staff.id)
      .run();

    await save({ month: '2020-01', 'cap_2020-01-10': '-1' });

    expect(await listForStaff(env.DB, staffId, { from: '2020-01-01', to: '2020-01-31' })).toEqual({
      '2020-01-10': 2
    });
  });

  it('「消す」以外の不正な値は保存しない', async () => {
    await save({ month: MONTH, 'cap_2099-01-10': '-2', 'cap_2099-01-11': '99', 'cap_2099-01-12': 'abc' });
    expect(await listForStaff(env.DB, staffId, RANGE)).toEqual({});
  });
});

describe('他人の分は触れない', () => {
  it('staff_id を送りつけても、ログイン中の本人の分として保存される', async () => {
    const fukuhara = await getStaffByName(env.DB, '普久原さん');

    await save({ month: MONTH, staff_id: String(fukuhara.id), 'cap_2099-01-10': '5' });

    expect(await listForStaff(env.DB, fukuhara.id, RANGE)).toEqual({});
    expect(await listForStaff(env.DB, staffId, RANGE)).toEqual({ '2099-01-10': 5 });
  });
});
