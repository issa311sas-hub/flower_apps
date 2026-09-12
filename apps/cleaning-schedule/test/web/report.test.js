/**
 * 清掃完了報告と現地精算の集計のテスト
 *
 * ★現地精算金額は給与から差し引く額なので、**消えたり食い違ったりしてはいけない**。
 * とくに「予約がキャンセルされても記録が残ること」は、
 * データ構造で意図的に担保している点なので必ず固定する。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/index.js';
import { createTestDb } from '../support/d1-sqlite.js';
import { createUser } from '../../src/db/users.js';
import { getStaffByName } from '../../src/db/staff.js';
import { saveAssignments, listAssignments } from '../../src/db/assignments.js';
import { applyFetchedBookings } from '../../src/db/bookings.js';
import { getReport, sumSettlements, sumSettlementsFor, parseSettlement } from '../../src/db/reports.js';
import { listNotifications } from '../../src/db/notifications.js';
import { setSetting } from '../../src/db/settings.js';

const ORIGIN = 'https://cleaning.example.workers.dev';
const PEPPER = 'test-pepper';
const FAST = { pepper: PEPPER, iterations: 1000 };
const RANGE = { from: '2099-01-01', to: '2099-01-31' };

let env;
const cookies = {};
const staffIds = {};

beforeEach(async () => {
  env = { DB: createTestDb(), SESSION_PEPPER: PEPPER };
  seeded = [];
  await login('hosoda', '細田さん');
});

async function login(loginId, staffName) {
  const staff = await getStaffByName(env.DB, staffName);
  staffIds[staffName] = staff.id;

  const created = await createUser(
    env.DB,
    { loginId, displayName: staffName, role: 'staff', staffId: staff.id, mustChange: false },
    FAST
  );
  const res = await worker.fetch(post('/login', { login_id: loginId, password: created.password }), env);
  cookies[staffName] = (res.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0];
  return cookies[staffName];
}

async function loginAdmin() {
  const created = await createUser(
    env.DB,
    { loginId: 'owner', displayName: '経営者', role: 'admin', mustChange: false },
    FAST
  );
  const res = await worker.fetch(post('/login', { login_id: 'owner', password: created.password }), env);
  return (res.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0];
}

function get(path, cookie) {
  return new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
}

function post(path, body, cookie) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body).toString()
  });
}

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

/**
 * 予約と割り当てを1件足す。
 *
 * ⚠ applyFetchedBookings / saveAssignments は「渡されたものが全部」という前提で、
 *   含まれない予約はキャンセル扱いにして削除する。
 *   毎回1件だけ渡すと前の分が消えるので、これまでの分もまとめて渡し直す。
 */
let seeded = [];

async function seed({ bookingId = '1', staffName = '細田さん', date = '2099-01-10', unit = 'b4' } = {}) {
  seeded.push({ bookingId, staffName, date, unit });

  await applyFetchedBookings(
    env.DB,
    seeded.map((b) => ({
      bookingId: b.bookingId,
      title: '',
      startDate: '2099-01-05',
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

const report = (bookingId, body, staffName = '細田さん') =>
  worker.fetch(post(`/me/report/${bookingId}`, body, cookies[staffName]), env);

describe('報告の保存', () => {
  it('入力した内容がそのまま残る', async () => {
    await seed();

    const res = await report('1', reportBody({ condition: 'C', settlement: '3000', note: '窓が汚れていた' }));
    expect(res.status).toBe(303);

    const saved = await getReport(env.DB, '1');
    expect(saved).toMatchObject({
      unit: 'b4',
      cleaningDate: '2099-01-10',
      staffName: '細田さん',
      condition: 'C',
      settlementYen: 3000,
      note: '窓が汚れていた'
    });
    expect(saved.answers).toHaveLength(8);
  });

  it('開き直すと入力した内容が入っている', async () => {
    await seed();
    await report('1', reportBody({ condition: 'A', settlement: '1200', equipment_iPad: 'ng' }));

    const body = await (await worker.fetch(get('/me/report/1', cookies['細田さん']), env)).text();

    expect(body).toContain('value="1200"');
    expect(body).toMatch(/id="cond-A"[^>]*checked/);
    expect(body).toMatch(/name="equipment_iPad" value="ng" checked/);
  });

  it('もう一度出すと上書きされる（二重に増えない）', async () => {
    await seed();
    await report('1', reportBody({ settlement: '1000' }));
    await report('1', reportBody({ settlement: '2500' }));

    expect((await getReport(env.DB, '1')).settlementYen).toBe(2500);
    expect(Number(await env.DB.prepare('SELECT COUNT(*) AS n FROM completion_reports').first('n'))).toBe(1);
    expect(Number(await env.DB.prepare('SELECT COUNT(*) AS n FROM report_answers').first('n'))).toBe(8);
  });

  it('取り消すと完了も報告も消える', async () => {
    await seed();
    await report('1', reportBody({ settlement: '5000' }));

    await worker.fetch(post('/me/report/1/undo', {}, cookies['細田さん']), env);

    expect(await getReport(env.DB, '1')).toBeNull();
    expect((await listAssignments(env.DB))[0].completedAt).toBeNull();
  });
});

describe('入力の検証', () => {
  beforeEach(() => seed());

  const rejects = async (body, contains) => {
    const res = await report('1', body);
    expect(res.status).toBe(400);
    if (contains) expect(await res.text()).toContain(contains);
    expect(await getReport(env.DB, '1')).toBeNull();
  };

  it('使用状況が未選択・不正なら保存しない', async () => {
    await rejects(reportBody({ condition: '' }), '使用状況を選んで');
    await rejects(reportBody({ condition: 'X' }));
  });

  it('金額が数字でなければ保存しない', async () => {
    await rejects(reportBody({ settlement: 'いくらか' }), '数字だけで');
    await rejects(reportBody({ settlement: '-100' }));
    await rejects(reportBody({ settlement: '1,000' }));
  });

  it('金額が大きすぎれば保存しない（打ち間違いを弾く）', async () => {
    await rejects(reportBody({ settlement: '99999999' }), '大きすぎます');
  });

  it('空欄は0として保存する', async () => {
    await report('1', reportBody({ settlement: '' }));
    expect((await getReport(env.DB, '1')).settlementYen).toBe(0);
  });

  it('設備・サービスの選択肢以外は保存しない', async () => {
    await rejects(reportBody({ equipment_電気: 'maybe' }), '電気');
    await rejects(reportBody({ 'service_海遊び': 'ok' }), '海遊び');
  });

  it('項目が未選択なら保存しない（入力漏れを通さない）', async () => {
    const body = reportBody();
    delete body.equipment_エアコン;
    await rejects(body, 'エアコン');
  });

  it('金額の検証は単体でも正しい', () => {
    expect(parseSettlement('')).toEqual({ ok: true, yen: 0 });
    expect(parseSettlement('0')).toEqual({ ok: true, yen: 0 });
    expect(parseSettlement(' 500 ')).toEqual({ ok: true, yen: 500 });
    expect(parseSettlement('-1').ok).toBe(false);
    expect(parseSettlement('1.5').ok).toBe(false);
  });
});

describe('現地精算の集計', () => {
  it('清掃員ごと・月ごとに合計する', async () => {
    await login('fukuhara', '普久原さん');

    await seed({ bookingId: '1', date: '2099-01-10' });
    await seed({ bookingId: '2', date: '2099-01-20', unit: 'b5' });
    await seed({ bookingId: '3', staffName: '普久原さん', date: '2099-01-15', unit: 's1' });
    await seed({ bookingId: '4', date: '2099-02-05', unit: 'b6' });

    await report('1', reportBody({ settlement: '3000' }));
    await report('2', reportBody({ settlement: '1500' }));
    await report('3', reportBody({ settlement: '800' }), '普久原さん');
    await report('4', reportBody({ settlement: '9999' }));

    const january = await sumSettlements(env.DB, RANGE);

    expect(january).toEqual([
      { staffId: staffIds['細田さん'], staffName: '細田さん', total: 4500, count: 2, withCash: 2 },
      { staffId: staffIds['普久原さん'], staffName: '普久原さん', total: 800, count: 1, withCash: 1 }
    ]);

    // 2月分は混ざらない
    const february = await sumSettlements(env.DB, { from: '2099-02-01', to: '2099-02-28' });
    expect(february).toEqual([
      { staffId: staffIds['細田さん'], staffName: '細田さん', total: 9999, count: 1, withCash: 1 }
    ]);
  });

  it('0円の報告は件数に入るが、受取件数には入らない', async () => {
    await seed();
    await report('1', reportBody({ settlement: '0' }));

    expect(await sumSettlements(env.DB, RANGE)).toEqual([
      { staffId: staffIds['細田さん'], staffName: '細田さん', total: 0, count: 1, withCash: 0 }
    ]);
  });

  it('本人の合計も出せる', async () => {
    await seed({ bookingId: '1' });
    await seed({ bookingId: '2', unit: 'b5' });
    await report('1', reportBody({ settlement: '1200' }));
    await report('2', reportBody({ settlement: '300' }));

    expect(await sumSettlementsFor(env.DB, staffIds['細田さん'], RANGE)).toEqual({ total: 1500, count: 2 });
  });

  it('★予約がキャンセルされても、金額の記録は残る', async () => {
    await seed();
    await report('1', reportBody({ settlement: '4000' }));

    // Beds24 の取得結果からこの予約が消える＝キャンセル。割り当ての行は削除される
    await applyFetchedBookings(env.DB, [], { from: '2099-01-01', to: '2099-12-31' }, '2099-01-20T00:00:00Z');
    await saveAssignments(env.DB, [], {});

    expect(await listAssignments(env.DB)).toHaveLength(0);

    const saved = await getReport(env.DB, '1');
    expect(saved.settlementYen).toBe(4000);
    expect(saved.staffName).toBe('細田さん');
    expect(saved.unit).toBe('b4');

    // 集計にも残っている（給与から差し引く額が消えない）
    expect(await sumSettlements(env.DB, RANGE)).toEqual([
      { staffId: staffIds['細田さん'], staffName: '細田さん', total: 4000, count: 1, withCash: 1 }
    ]);
  });
});

describe('気づいてほしいことの通知', () => {
  const kinds = async () => (await listNotifications(env.DB)).map((n) => n.kind);

  it('ふつうの報告では通知しない', async () => {
    await seed();
    await report('1', reportBody());
    expect(await kinds()).not.toContain('report_alert');
  });

  it('現地精算があれば通知する', async () => {
    await seed();
    await report('1', reportBody({ settlement: '3000' }));

    const [notification] = await listNotifications(env.DB);
    expect(notification.kind).toBe('report_alert');
    expect(notification.body).toContain('3,000円');
    expect(notification.body).toContain('細田さん');
  });

  it('使用状況 F と設備の不具合は強く知らせる', async () => {
    await seed();
    await report('1', reportBody({ condition: 'F', equipment_エアコン: 'ng' }));

    const [notification] = await listNotifications(env.DB);
    expect(notification.level).toBe('error');
    expect(notification.body).toContain('受け入れ拒否');
    expect(notification.body).toContain('エアコン');
  });

  it('未清掃のサービスも知らせる', async () => {
    await seed();
    await report('1', reportBody({ 'service_バーベキュー': 'not_cleaned' }));

    expect((await listNotifications(env.DB))[0].body).toContain('未清掃');
  });

  it('続けて報告しても、まとめられずに1件ずつ届く', async () => {
    await seed({ bookingId: '1' });
    await seed({ bookingId: '2', unit: 'b5' });

    await report('1', reportBody({ settlement: '1000' }));
    await report('2', reportBody({ settlement: '2000' }));

    expect((await listNotifications(env.DB)).filter((n) => n.kind === 'report_alert')).toHaveLength(2);
  });
});

describe('管理画面', () => {
  it('清掃員ごとの差し引き額と一覧が出る', async () => {
    const admin = await loginAdmin();
    await seed();
    await report('1', reportBody({ condition: 'F', settlement: '3000', equipment_iPad: 'ng' }));

    const body = await (await worker.fetch(get('/admin/reports?month=2099-01', admin), env)).text();

    expect(body).toContain('給与から差し引く額');
    expect(body).toContain('3,000円');
    expect(body).toContain('細田さん');
    expect(body).toContain('受け入れ拒否');
    expect(body).toContain('設備✕ iPad');
  });

  it('詳細で全項目を確認できる', async () => {
    const admin = await loginAdmin();
    await seed();
    await report('1', reportBody({ 'service_海遊び': 'cleaned' }));

    const body = await (await worker.fetch(get('/admin/reports/1', admin), env)).text();

    expect(body).toContain('FireStick');
    expect(body).toContain('海遊び');
    expect(body).toContain('あり（清掃済）');
  });

  it('スタッフは集計を見られない', async () => {
    const res = await worker.fetch(get('/admin/reports', cookies['細田さん']), env);
    expect(res.headers.get('location')).toBe('/me');
  });
});

describe('報告フォームの項目', () => {
  it('設定した項目が出る', async () => {
    await seed();
    await setSetting(env.DB, 'report_equipment', '玄関の鍵\nWi-Fi');
    await setSetting(env.DB, 'report_services', 'サウナ');

    const body = await (await worker.fetch(get('/me/report/1', cookies['細田さん']), env)).text();

    expect(body).toContain('玄関の鍵');
    expect(body).toContain('Wi-Fi');
    expect(body).toContain('サウナ');
    expect(body).not.toContain('FireStick');
  });

  it('項目を変えても、過去の報告は当時のまま残る', async () => {
    await seed();
    await report('1', reportBody());

    await setSetting(env.DB, 'report_equipment', '玄関の鍵');

    const saved = await getReport(env.DB, '1');
    expect(saved.answers.map((a) => a.label)).toContain('FireStick');
  });
});
