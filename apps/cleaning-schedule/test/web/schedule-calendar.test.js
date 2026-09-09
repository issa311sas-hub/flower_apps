/**
 * スタッフの予定のカレンダー表示のテスト
 *
 * 旧運用では Google カレンダーで予定を確認してもらっていたので、同じ見え方を用意した。
 * **見るだけ**の画面で、完了報告のボタンはリスト側にしか置かない。
 * 「押せるはずのものが押せない」より「見る画面と押す画面が分かれている」ほうが、
 * 押し忘れに気づきやすいため。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/index.js';
import { createTestDb } from '../support/d1-sqlite.js';
import { createUser } from '../../src/db/users.js';
import { getStaffByName } from '../../src/db/staff.js';
import { saveAssignments, markCompleted } from '../../src/db/assignments.js';
import { applyFetchedBookings } from '../../src/db/bookings.js';

const ORIGIN = 'https://cleaning.example.workers.dev';
const PEPPER = 'test-pepper';
const FAST = { pepper: PEPPER, iterations: 1000 };
const MONTH = '2099-01';

let env;
let cookie;
let seeded = [];

beforeEach(async () => {
  env = { DB: createTestDb(), SESSION_PEPPER: PEPPER };
  seeded = [];

  const staff = await getStaffByName(env.DB, '細田さん');
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

function post(path, body) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
    body: new URLSearchParams(body).toString()
  });
}

const show = async (path) => (await worker.fetch(get(path), env)).text();

async function seed({ bookingId, date, unit, staffName = '細田さん' }) {
  seeded.push({ bookingId, date, unit, staffName });

  await applyFetchedBookings(
    env.DB,
    seeded.map((b) => ({
      bookingId: b.bookingId,
      title: '',
      startDate: '2099-01-01',
      checkoutDate: b.date,
      unit: b.unit,
      guests: 2
    })),
    { from: '2099-01-01', to: '2099-12-31' },
    '2099-01-01T00:00:00Z'
  );

  await saveAssignments(
    env.DB,
    seeded.map((b) => ({
      bookingId: b.bookingId,
      checkoutDate: b.date,
      cleaningDate: b.date,
      unit: b.unit,
      title: '',
      staffName: b.staffName,
      status: '確定',
      isManual: false
    })),
    {}
  );
}

/** カレンダーの1マスを取り出す */
function cellFor(body, day) {
  const match = body.match(
    new RegExp(`<div class="cal-cell[^"]*">\\s*<span class="cal-day">${day}</span>[\\s\\S]*?</div>`)
  );
  return match ? match[0] : null;
}

describe('画面の切り替え', () => {
  it('既定はこれまでどおりのリスト', async () => {
    const body = await show('/me');

    expect(body).not.toContain('class="calendar readonly"');
    expect(body).toContain('これからの予定');
  });

  it('?view=calendar で月表示になる', async () => {
    const body = await show(`/me?view=calendar&month=${MONTH}`);

    expect(body).toContain('class="calendar readonly"');
    expect(body).toContain('<div class="cal-head sun">日</div>');
  });

  it('どちらからも、もう一方に行ける', async () => {
    expect(await show('/me')).toContain('href="/me?view=calendar"');
    expect(await show('/me?view=calendar')).toContain('href="/me"');
  });
});

describe('カレンダーの中身', () => {
  it('担当した日にユニット名が入る', async () => {
    await seed({ bookingId: '1', date: '2099-01-10', unit: 'b4' });

    const body = await show(`/me?view=calendar&month=${MONTH}`);

    expect(cellFor(body, 10)).toContain('b4');
    expect(cellFor(body, 11)).toContain('<span class="cal-jobs"></span>');
  });

  it('同じ日に何件あっても全部出る', async () => {
    await seed({ bookingId: '1', date: '2099-01-10', unit: 'b4' });
    await seed({ bookingId: '2', date: '2099-01-10', unit: 's1' });

    const cell = cellFor(await show(`/me?view=calendar&month=${MONTH}`), 10);

    expect(cell).toContain('b4');
    expect(cell).toContain('s1');
  });

  it('完了したものには印が付く', async () => {
    await seed({ bookingId: '1', date: '2099-01-10', unit: 'b4' });
    await seed({ bookingId: '2', date: '2099-01-11', unit: 'b5' });
    await markCompleted(env.DB, '1');

    const body = await show(`/me?view=calendar&month=${MONTH}`);

    expect(cellFor(body, 10)).toContain('cal-job done');
    expect(cellFor(body, 10)).toContain('✓');
    expect(cellFor(body, 11)).not.toContain('done');
  });

  it('件数と完了数を先に伝える', async () => {
    await seed({ bookingId: '1', date: '2099-01-10', unit: 'b4' });
    await seed({ bookingId: '2', date: '2099-01-20', unit: 'b5' });
    await markCompleted(env.DB, '1');

    expect(await show(`/me?view=calendar&month=${MONTH}`)).toContain('2099年1月は 2件（完了 1件）です');
  });

  it('他人の担当は出ない', async () => {
    await seed({ bookingId: '1', date: '2099-01-10', unit: 'b4' });
    await seed({ bookingId: '2', date: '2099-01-12', unit: 's1', staffName: '普久原さん' });

    const body = await show(`/me?view=calendar&month=${MONTH}`);

    expect(cellFor(body, 10)).toContain('b4');
    expect(cellFor(body, 12)).not.toContain('s1');
  });

  it('月初の曜日まで空セルが入る', async () => {
    // 2099-01-01 は木曜なので、前に4つ
    const body = await show(`/me?view=calendar&month=${MONTH}`);
    expect(body.match(/<div class="cal-blank"><\/div>/g) ?? []).toHaveLength(4);
  });

  it('月を切り替えられる', async () => {
    await seed({ bookingId: '1', date: '2099-02-05', unit: 'c4' });

    expect(await show('/me?view=calendar&month=2099-01')).toContain('2099年1月は 0件');
    expect(cellFor(await show('/me?view=calendar&month=2099-02'), 5)).toContain('c4');
  });
});

describe('見るだけの画面である', () => {
  it('カレンダーに完了報告のボタンを置かない', async () => {
    await seed({ bookingId: '1', date: '2099-01-10', unit: 'b4' });

    const body = await show(`/me?view=calendar&month=${MONTH}`);

    expect(body).not.toContain('清掃おわりました</a>');
    expect(body).not.toContain('/me/report/1');
    // 押す場所はリスト側だと案内する
    expect(body).toContain('これからの予定');
  });

  it('リスト側にはこれまでどおりボタンがある', async () => {
    const body = await show('/me');
    expect(body).toContain('これからの予定');
  });
});
