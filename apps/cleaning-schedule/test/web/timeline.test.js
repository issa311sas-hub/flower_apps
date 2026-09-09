/**
 * 手動変更とタイムラインのテスト
 *
 * 一番大事なのは「手で決めた担当が、翌朝の自動実行で勝手に戻らないこと」。
 * ここが守られないと、管理者は毎日同じ変更をやり直すことになり、
 * 画面そのものが使われなくなる。実際に自動実行を回して確認する。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/index.js';
import { createTestDb } from '../support/d1-sqlite.js';
import { createUser } from '../../src/db/users.js';
import { getStaffByName } from '../../src/db/staff.js';
import { replaceUnitMap } from '../../src/db/units.js';
import { setCapacityBulk } from '../../src/db/availability.js';
import { listAssignments, getAssignment, saveAssignments } from '../../src/db/assignments.js';
import { applyFetchedBookings } from '../../src/db/bookings.js';
import { saveTokens } from '../../src/db/beds24Auth.js';
import { runDaily } from '../../src/jobs/dailyRun.js';
import { runNow } from '../../src/web/pages/runs.js';

const ORIGIN = 'https://cleaning.example.workers.dev';
const PEPPER = 'test-pepper';
const ENC_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const FAST = { pepper: PEPPER, iterations: 1000 };

/** 2026-09-10 09:00 JST */
const NOW = Date.parse('2026-09-10T00:00:00Z');
const CHECKOUT = '2026-09-12';

let env;
let cookie;
let adminId;

beforeEach(async () => {
  env = { DB: createTestDb(), SESSION_PEPPER: PEPPER, TOKEN_ENC_KEY: ENC_KEY };

  const created = await createUser(
    env.DB,
    { loginId: 'owner', displayName: '経営者', role: 'admin', mustChange: false },
    FAST
  );
  adminId = created.id;

  const res = await worker.fetch(post('/login', { login_id: 'owner', password: created.password }), env);
  cookie = (res.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0];
});

function get(path, cookieValue = cookie) {
  return new Request(`${ORIGIN}${path}`, { headers: cookieValue ? { cookie: cookieValue } : {} });
}

function post(path, body, { cookie: cookieValue, origin = ORIGIN } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (cookieValue) headers.cookie = cookieValue;
  if (origin !== null) headers.origin = origin;
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body).toString()
  });
}

/** 予約1件と、その割り当てを用意する */
async function seed({ staffName = '細田さん', cleaningDate = CHECKOUT } = {}) {
  await applyFetchedBookings(
    env.DB,
    [{ bookingId: '555', title: '消毒ポット', startDate: '2026-09-08', checkoutDate: CHECKOUT, unit: 'b4', guests: 2 }],
    { from: '2026-09-01', to: '2026-12-31' },
    '2026-09-10T00:00:00Z'
  );

  await saveAssignments(
    env.DB,
    [
      {
        bookingId: '555',
        checkoutDate: CHECKOUT,
        cleaningDate,
        unit: 'b4',
        title: '消毒ポット',
        staffName,
        status: '確定',
        isManual: false
      }
    ],
    { nextGuests: { 555: 3 } }
  );
}

/** Beds24 の代わり。毎回おなじ予約1件を返す */
const beds24Stub = async () => ({
  ok: true,
  status: 200,
  json: async () => [
    {
      id: 555,
      roomId: 100,
      unitId: 1,
      guestTitle: '消毒ポット',
      arrival: '2026-09-08',
      departure: CHECKOUT,
      numAdult: 2,
      status: 'confirmed'
    }
  ],
  text: async () => ''
});

async function connectBeds24() {
  await replaceUnitMap(env.DB, [{ roomId: '100', unitId: '1', unitName: 'b4' }]);
  await saveTokens(env.DB, ENC_KEY, { refreshToken: 'r', accessToken: 'a', expiresInSec: 86400 }, '2026-09-10T00:00:00Z');
}

/** 自動実行を1回まわす */
async function runAuto() {
  await connectBeds24();
  return runDaily(env, { kind: 'manual', now: NOW, fetchImpl: beds24Stub, sleep: async () => {} });
}

/**
 * 管理画面の実行ボタン。
 * ルート経由（worker.fetch）だと fetch を差し替えられず実際に外へ出てしまうため、
 * ハンドラを直接呼ぶ。ルーティング自体は別のテストで確認している。
 */
async function pressRun({ rebuild = false, cookie: cookieValue = cookie } = {}) {
  await connectBeds24();
  return runNow(post('/admin/run', rebuild ? { rebuild: '1' } : {}, { cookie: cookieValue }), env, {
    now: NOW,
    fetchImpl: beds24Stub,
    sleep: async () => {}
  });
}

describe('担当の手動変更', () => {
  it('担当を変えると固定され、次の自動実行でも戻らない', async () => {
    await seed({ staffName: '細田さん' });

    // 普久原さんだけが出勤できる状態にしておく。自動なら普久原さんになる
    const fukuhara = await getStaffByName(env.DB, '普久原さん');
    await setCapacityBulk(env.DB, fukuhara.id, [{ date: CHECKOUT, capacity: 3 }]);

    const res = await worker.fetch(
      post('/admin/assignments/555', { staff_name: '福田さん', cleaning_date: CHECKOUT }, { cookie }),
      env
    );
    expect(res.status).toBe(303);

    const after = await getAssignment(env.DB, '555');
    expect(after.staffName).toBe('福田さん');
    expect(after.isManual).toBe(true);

    // ★ここが本題。自動実行しても手で決めた担当のまま
    const result = await runAuto();
    expect(result.ok).toBe(true);
    expect((await getAssignment(env.DB, '555')).staffName).toBe('福田さん');
  });

  it('固定を解除しても、担当はすぐには変わらない', async () => {
    // エンジンは予約に変更がなければ前回の担当を引き継ぐ（無用な入れ替えを避ける設計）。
    // 「解除＝決め直し」ではないことを、画面の文言と揃えて固定しておく
    await seed({ staffName: '細田さん' });
    await worker.fetch(
      post('/admin/assignments/555', { staff_name: '福田さん', cleaning_date: CHECKOUT }, { cookie }),
      env
    );

    const fukuhara = await getStaffByName(env.DB, '普久原さん');
    await setCapacityBulk(env.DB, fukuhara.id, [{ date: CHECKOUT, capacity: 3 }]);

    await worker.fetch(post('/admin/assignments/555/auto', {}, { cookie }), env);
    expect((await getAssignment(env.DB, '555')).isManual).toBe(false);

    await runAuto();
    expect((await getAssignment(env.DB, '555')).staffName).toBe('福田さん');
  });

  it('「担当を決め直す」なら、次の実行で選び直される', async () => {
    await seed({ staffName: '細田さん', cleaningDate: '2026-09-14' });
    await worker.fetch(
      post('/admin/assignments/555', { staff_name: '福田さん', cleaning_date: '2026-09-14' }, { cookie }),
      env
    );

    const fukuhara = await getStaffByName(env.DB, '普久原さん');
    await setCapacityBulk(env.DB, fukuhara.id, [{ date: CHECKOUT, capacity: 3 }]);

    const res = await worker.fetch(post('/admin/assignments/555/reset', {}, { cookie }), env);
    expect(res.headers.get('location')).toContain('saved=reset');

    // 未割当に戻り、清掃日も退去日に戻る（延期も含めて選び直せるように）
    const reset = await getAssignment(env.DB, '555');
    expect(reset.staffName).toBe('未割当');
    expect(reset.cleaningDate).toBe(CHECKOUT);
    expect(reset.isManual).toBe(false);

    await runAuto();
    expect((await getAssignment(env.DB, '555')).staffName).toBe('普久原さん');
  });

  it('状態は担当から決まる（外注・未割当）', async () => {
    await seed();

    await worker.fetch(
      post('/admin/assignments/555', { staff_name: 'Rクリーン', cleaning_date: CHECKOUT }, { cookie }),
      env
    );
    expect((await getAssignment(env.DB, '555')).status).toBe('外注');

    await worker.fetch(
      post('/admin/assignments/555', { staff_name: '未割当', cleaning_date: CHECKOUT }, { cookie }),
      env
    );
    expect((await getAssignment(env.DB, '555')).status).toBe('要確認');
  });

  it('退去日より前の清掃日は受け付けない', async () => {
    await seed();

    const res = await worker.fetch(
      post('/admin/assignments/555', { staff_name: '福田さん', cleaning_date: '2026-09-11' }, { cookie }),
      env
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('範囲で指定してください');
    expect((await getAssignment(env.DB, '555')).staffName).toBe('細田さん');
  });

  it('+2日を超える清掃日は受け付けない（害虫防止の絶対条件）', async () => {
    await seed();

    const res = await worker.fetch(
      post('/admin/assignments/555', { staff_name: '福田さん', cleaning_date: '2026-09-15' }, { cookie }),
      env
    );

    expect(res.status).toBe(400);
    expect((await getAssignment(env.DB, '555')).cleaningDate).toBe(CHECKOUT);
  });

  it('+2日以内なら延期できる', async () => {
    await seed();

    await worker.fetch(
      post('/admin/assignments/555', { staff_name: '福田さん', cleaning_date: '2026-09-14' }, { cookie }),
      env
    );

    expect((await getAssignment(env.DB, '555')).cleaningDate).toBe('2026-09-14');
  });

  it('誰がいつ変えたかが履歴に残る', async () => {
    await seed();
    await worker.fetch(
      post('/admin/assignments/555', { staff_name: '福田さん', cleaning_date: CHECKOUT }, { cookie }),
      env
    );

    const { results } = await env.DB.prepare('SELECT * FROM assignment_history WHERE booking_id = ?').bind('555').all();
    expect(results).toHaveLength(1);
    expect(results[0].changed_by).toBe('owner');
    expect(results[0].old_staff).toBe('細田さん');
    expect(results[0].new_staff).toBe('福田さん');

    const body = await (await worker.fetch(get('/admin/assignments/555'), env)).text();
    expect(body).toContain('細田さん → 福田さん');
  });

  it('存在しない担当者名は受け付けない', async () => {
    await seed();
    const res = await worker.fetch(
      post('/admin/assignments/555', { staff_name: '知らない人', cleaning_date: CHECKOUT }, { cookie }),
      env
    );

    expect(res.status).toBe(400);
    expect((await getAssignment(env.DB, '555')).staffName).toBe('細田さん');
  });

  it('スタッフは手動変更できない', async () => {
    await seed();
    const staff = await getStaffByName(env.DB, '細田さん');
    const created = await createUser(
      env.DB,
      { loginId: 'hosoda', displayName: '細田さん', role: 'staff', staffId: staff.id, mustChange: false },
      FAST
    );
    const login = await worker.fetch(post('/login', { login_id: 'hosoda', password: created.password }), env);
    const sid = (login.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0];

    const res = await worker.fetch(
      post('/admin/assignments/555', { staff_name: 'Rクリーン', cleaning_date: CHECKOUT }, { cookie: sid }),
      env
    );

    expect(res.headers.get('location')).toBe('/me');
    expect((await getAssignment(env.DB, '555')).staffName).toBe('細田さん');
  });

  it('Origin の無いPOSTは拒否する', async () => {
    await seed();
    const res = await worker.fetch(
      post('/admin/assignments/555', { staff_name: 'Rクリーン', cleaning_date: CHECKOUT }, { cookie, origin: null }),
      env
    );

    expect(res.status).toBe(403);
    expect((await getAssignment(env.DB, '555')).staffName).toBe('細田さん');
  });

  it('存在しない予約は404', async () => {
    const res = await worker.fetch(get('/admin/assignments/nope'), env);
    expect(res.status).toBe(404);
  });
});

describe('タイムライン', () => {
  it('ユニットが旧版と同じ並びで9行出る', async () => {
    const body = await (await worker.fetch(get('/admin/timeline'), env)).text();

    const order = [...body.matchAll(/<th class="unit-col">(b\d|s\d|c\d)<\/th>/g)].map((m) => m[1]);
    expect(order).toEqual(['b4', 'b5', 'b6', 'b2', 'b3', 's1', 's2', 's3', 'c4']);
  });

  it('担当者は略称で表示され、変更画面に飛べる', async () => {
    await seed({ staffName: '細田さん' });

    const body = await (await worker.fetch(get(`/admin/timeline?from=${CHECKOUT}&days=7`), env)).text();

    expect(body).toContain('/admin/assignments/555');
    expect(body).toContain('>細<');
  });

  it('出勤枠が並び、未入力の日は「-」になる', async () => {
    const hosoda = await getStaffByName(env.DB, '細田さん');
    await setCapacityBulk(env.DB, hosoda.id, [{ date: CHECKOUT, capacity: 2 }]);

    const body = await (await worker.fetch(get(`/admin/timeline?from=${CHECKOUT}&days=7`), env)).text();

    expect(body).toContain('出勤枠');
    expect(body).toContain('>2</td>');
    expect(body).toContain('class="unset">-</td>');
    // 外注（Rクリーン）は自分で入力しないので、この行には出さない
    expect(body).not.toContain('>R</th>');
  });

  it('未割当の件数を最初に伝える', async () => {
    await seed({ staffName: '未割当' });

    const body = await (await worker.fetch(get(`/admin/timeline?from=${CHECKOUT}&days=7`), env)).text();
    expect(body).toContain('未割当 1件');
    expect(body).toContain('cell-unassigned');
  });

  it('未ログインだとログイン画面に送られる', async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/admin/timeline`), env);
    expect(res.headers.get('location')).toContain('/login');
  });
});

describe('ゼロから割り当て直す', () => {
  /** 出勤入力が空のまま実行して、全部を外注に落とす（実運用で踏んだ状態を作る） */
  async function outsourceEverything() {
    await runAuto();
    expect((await getAssignment(env.DB, '555')).staffName).toBe('Rクリーン');
  }

  it('あとから出勤入力を入れれば、押さなくても取り戻せる（Phase 1.4）', async () => {
    await outsourceEverything();

    const hosoda = await getStaffByName(env.DB, '細田さん');
    await setCapacityBulk(env.DB, hosoda.id, [{ date: CHECKOUT, capacity: 3 }]);

    await runAuto();
    expect((await getAssignment(env.DB, '555')).staffName).toBe('細田さん');
  });

  it('ボタンを押すと白紙に戻してから決め直す', async () => {
    await outsourceEverything();

    const hosoda = await getStaffByName(env.DB, '細田さん');
    await setCapacityBulk(env.DB, hosoda.id, [{ date: CHECKOUT, capacity: 3 }]);

    const res = await pressRun({ rebuild: true });
    expect(res.status).toBe(303);

    expect((await getAssignment(env.DB, '555')).staffName).toBe('細田さん');
  });

  it('手で固定した分は白紙に戻さない', async () => {
    await seed({ staffName: '細田さん' });
    await worker.fetch(
      post('/admin/assignments/555', { staff_name: '福田さん', cleaning_date: CHECKOUT }, { cookie }),
      env
    );

    await pressRun({ rebuild: true });

    const after = await getAssignment(env.DB, '555');
    expect(after.staffName).toBe('福田さん');
    expect(after.isManual).toBe(true);
  });

  it('完了報告が済んだ分は白紙に戻さない', async () => {
    await seed({ staffName: '細田さん' });
    await env.DB.prepare("UPDATE assignments SET completed_at = '2026-09-12T02:00:00Z' WHERE booking_id = '555'").run();

    await pressRun({ rebuild: true });

    const after = await getAssignment(env.DB, '555');
    expect(after.staffName).toBe('細田さん');
    expect(after.completedAt).toBeTruthy();
  });

  it('過去の割り当ては白紙に戻さない', async () => {
    const { resetAllAssignments } = await import('../../src/db/assignments.js');
    await seed({ staffName: '細田さん', cleaningDate: CHECKOUT });

    const result = await resetAllAssignments(env.DB, { from: '2026-12-01' });

    expect(result.reset).toBe(0);
    expect((await getAssignment(env.DB, '555')).staffName).toBe('細田さん');
  });

  it('スタッフは押せない', async () => {
    await seed({ staffName: '細田さん' });
    const staff = await getStaffByName(env.DB, '細田さん');
    const created = await createUser(
      env.DB,
      { loginId: 'hosoda', displayName: '細田さん', role: 'staff', staffId: staff.id, mustChange: false },
      FAST
    );
    const login = await worker.fetch(post('/login', { login_id: 'hosoda', password: created.password }), env);
    const sid = (login.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0];

    const res = await pressRun({ rebuild: true, cookie: sid });

    expect(res.headers.get('location')).toBe('/me');
    expect((await getAssignment(env.DB, '555')).staffName).toBe('細田さん');
  });
});
