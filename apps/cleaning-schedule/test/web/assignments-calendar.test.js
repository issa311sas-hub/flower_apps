/**
 * 割り当てのカレンダー表示（管理者）のテスト
 *
 * 一覧は日付順に細かく読む用、タイムラインはユニット × 日付で棟の空きを見る用、
 * カレンダーは「その月に誰がどれだけ入っているか」を掴む用。
 *
 * 一番大事なのは**未割当が目立つこと**。未割当はそのまま外注費か穴になるので、
 * 月の形にしたときに紛れて見えなくなっては意味がない。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/index.js';
import { createTestDb } from '../support/d1-sqlite.js';
import { createUser } from '../../src/db/users.js';
import { applyFetchedBookings } from '../../src/db/bookings.js';
import { saveAssignments } from '../../src/db/assignments.js';

const ORIGIN = 'https://cleaning.example.workers.dev';
const PEPPER = 'test-pepper';
const FAST = { pepper: PEPPER, iterations: 1000 };

const MONTH = '2026-09';
const RANGE = { from: '2026-09-01', to: '2026-12-31' };
const AT = '2026-09-10T00:00:00Z';

let env;
let cookie;

beforeEach(async () => {
  env = { DB: createTestDb(), SESSION_PEPPER: PEPPER };
  const created = await createUser(
    env.DB,
    { loginId: 'owner', displayName: '経営者', role: 'admin', mustChange: false },
    FAST
  );
  const res = await worker.fetch(post('/login', { login_id: 'owner', password: created.password }), env);
  cookie = (res.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0];
});

function get(path, cookieValue = cookie) {
  return new Request(`${ORIGIN}${path}`, { headers: cookieValue ? { cookie: cookieValue } : {} });
}

function post(path, body) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
    body: new URLSearchParams(body).toString()
  });
}

/**
 * 予約と割り当てをまとめて用意する。
 * applyFetchedBookings は「渡した分がすべて」なので、必ず1回で全部渡す
 * （小分けにすると前に入れたものがキャンセル扱いで消える）。
 */
async function seed(items) {
  await applyFetchedBookings(
    env.DB,
    items.map((i) => ({
      bookingId: i.bookingId,
      title: i.title ?? '',
      startDate: '2026-09-01',
      checkoutDate: i.date,
      unit: i.unit,
      guests: 2
    })),
    RANGE,
    AT
  );

  await saveAssignments(
    env.DB,
    items.map((i) => ({
      bookingId: i.bookingId,
      checkoutDate: i.date,
      cleaningDate: i.date,
      unit: i.unit,
      title: i.title ?? '',
      staffName: i.staffName,
      status: i.status ?? '確定',
      isManual: i.isManual ?? false
    })),
    {}
  );
}

const calendar = async (query = '') =>
  (await worker.fetch(get(`/admin/assignments?view=calendar&month=${MONTH}${query}`), env)).text();

describe('割り当てのカレンダー', () => {
  it('カレンダーに切り替えられる', async () => {
    const body = await (await worker.fetch(get('/admin/assignments'), env)).text();
    expect(body).toContain('view=calendar');
  });

  it('既定は一覧のまま（従来の画面を変えない）', async () => {
    const body = await (await worker.fetch(get('/admin/assignments'), env)).text();
    expect(body).toContain('<th>清掃日</th>');
    expect(body).not.toContain('class="calendar readonly assignments"');
  });

  it('その月の割り当てが、ユニットと担当者つきで出る', async () => {
    await seed([{ bookingId: '1', unit: 'b4', date: '2026-09-12', staffName: '細田さん' }]);

    const body = await calendar();
    expect(body).toContain('class="calendar readonly assignments"');
    expect(body).toContain('b4');
    expect(body).toContain('細'); // 短縮名
  });

  it('1件ずつが変更画面への入口になっている', async () => {
    await seed([{ bookingId: '1', unit: 'b4', date: '2026-09-12', staffName: '細田さん' }]);

    const body = await calendar();
    expect(body).toContain('href="/admin/assignments/1"');
  });

  it('★未割当は目立つ色で出る（そのまま外注費か穴になるため）', async () => {
    await seed([{ bookingId: '1', unit: 'b4', date: '2026-09-12', staffName: '未割当', status: '要確認' }]);

    const body = await calendar();
    expect(body).toContain('job-unassigned');
  });

  it('外注と担当者は別の色になる', async () => {
    await seed([
      { bookingId: '1', unit: 'b4', date: '2026-09-12', staffName: '細田さん' },
      { bookingId: '2', unit: 'b5', date: '2026-09-12', staffName: 'Rクリーン' }
    ]);

    const body = await calendar();
    expect(body).toContain('job-staff-1');
    expect(body).toContain('job-outsource');
  });

  it('完了と手動固定が印で分かる', async () => {
    await seed([{ bookingId: '1', unit: 'b4', date: '2026-09-12', staffName: '細田さん', isManual: true }]);

    const body = await calendar();
    expect(body).toContain('manual-mark');
  });

  it('同じ日に複数あれば、その日のマスに並ぶ', async () => {
    await seed([
      { bookingId: '1', unit: 'b4', date: '2026-09-12', staffName: '細田さん' },
      { bookingId: '2', unit: 'b5', date: '2026-09-12', staffName: '普久原さん' }
    ]);

    const body = await calendar();
    expect(body).toContain('href="/admin/assignments/1"');
    expect(body).toContain('href="/admin/assignments/2"');
  });

  it('別の月の予定は出ない', async () => {
    await seed([{ bookingId: '1', unit: 'b4', date: '2026-10-05', staffName: '細田さん' }]);

    const body = await calendar();
    expect(body).not.toContain('href="/admin/assignments/1"');
  });

  it('担当者で絞り込める', async () => {
    await seed([
      { bookingId: '1', unit: 'b4', date: '2026-09-12', staffName: '細田さん' },
      { bookingId: '2', unit: 'b5', date: '2026-09-12', staffName: '普久原さん' }
    ]);

    const body = await calendar('&staff=' + encodeURIComponent('細田さん'));
    expect(body).toContain('href="/admin/assignments/1"');
    expect(body).not.toContain('href="/admin/assignments/2"');
  });

  it('絞り込みは月を移動しても続く', async () => {
    const body = await calendar('&staff=' + encodeURIComponent('細田さん'));
    expect(body).toContain('month=2026-10&staff=');
    expect(body).toContain('month=2026-08&staff=');
  });

  it('前後の月へ移動できる', async () => {
    const body = await calendar();
    expect(body).toContain('month=2026-08');
    expect(body).toContain('month=2026-10');
  });

  it('件数の内訳は一覧と同じものが出る', async () => {
    await seed([
      { bookingId: '1', unit: 'b4', date: '2026-09-12', staffName: '未割当', status: '要確認' },
      { bookingId: '2', unit: 'b5', date: '2026-09-13', staffName: 'Rクリーン' }
    ]);

    const body = await calendar();
    expect(body).toContain('未割当 1件');
    expect(body).toContain('外注 1件');
  });

  it('★スタッフ権限では開けない', async () => {
    const res = await worker.fetch(get(`/admin/assignments?view=calendar&month=${MONTH}`, null), env);
    expect(res.status).not.toBe(200);
  });
});
