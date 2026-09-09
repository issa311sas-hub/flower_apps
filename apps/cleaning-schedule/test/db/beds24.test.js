/**
 * Beds24 連携と日次処理のテスト
 *
 * 本物の Beds24 は叩かず、応答を差し替えて検証する。
 * 実際の接続は現行の GAS 版とトークンを取り合うため、
 * 実装が固まるまで本番のBeds24にはつながない（docs/deploy-guide.md 参照）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../support/d1-sqlite.js';
import { toAppBooking, fetchBookings, connectWithInviteCode, getAccessToken } from '../../src/integrations/beds24.js';
import { getAuthStatus, getRefreshToken, STATE } from '../../src/db/beds24Auth.js';
import { replaceUnitMap } from '../../src/db/units.js';
import { setCapacityBulk } from '../../src/db/availability.js';
import { getStaffByName } from '../../src/db/staff.js';
import { listAssignments } from '../../src/db/assignments.js';
import { listActiveBookings } from '../../src/db/bookings.js';
import { listRuns } from '../../src/db/runs.js';
import { listUnacknowledged } from '../../src/db/notifications.js';
import { runDaily } from '../../src/jobs/dailyRun.js';

// テスト用の暗号鍵（32バイトのbase64）
const ENC_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

let db;
beforeEach(async () => {
  db = createTestDb();
  await replaceUnitMap(db, [
    { roomId: '100', unitId: '1', unitName: 'b4' },
    { roomId: '100', unitId: '2', unitName: 'b5' },
    { roomId: '200', unitId: '', unitName: 's1' }
  ]);
});

/** fetch の代わり。呼ばれたURLを記録しつつ、決めた応答を返す */
function stubFetch(handlers) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    for (const [pattern, respond] of handlers) {
      if (url.includes(pattern)) return respond(url, init, calls);
    }
    throw new Error(`想定していないURLが呼ばれました: ${url}`);
  };
  impl.calls = calls;
  return impl;
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body)
});

describe('予約データの変換', () => {
  const lookup = new Map([
    ['100:1', 'b4'],
    ['200:', 's1']
  ]);

  it('通常の予約を変換できる', () => {
    const { booking } = toAppBooking(
      {
        id: 123,
        roomId: 100,
        unitId: 1,
        guestTitle: '消毒ポット',
        arrival: '2026-09-05',
        departure: '2026-09-10',
        numAdult: 2,
        numChild: 1,
        status: 'confirmed'
      },
      lookup
    );

    expect(booking).toEqual({
      bookingId: '123',
      title: '消毒ポット',
      startDate: '2026-09-05',
      checkoutDate: '2026-09-10',
      unit: 'b4',
      guests: 3,
      rawRoomId: '100',
      rawUnitId: '1'
    });
  });

  it('キャンセル済みは取り込まない', () => {
    for (const status of ['cancelled', 'canceled', 'deleted', 'CANCELLED']) {
      const result = toAppBooking({ id: 1, roomId: 100, unitId: 1, status }, lookup);
      expect(result.skipped).toBe('cancelled');
    }
  });

  it('マッピング未設定のユニットは取り込まず、記録に残す', () => {
    const result = toAppBooking({ id: 1, roomId: 999, unitId: 9, status: 'confirmed' }, lookup);
    expect(result.skipped).toBe('unmapped');
    expect(result.roomId).toBe('999');
  });

  it('departure がない場合は最終宿泊日の翌日をチェックアウト日にする', () => {
    const { booking } = toAppBooking(
      { id: 1, roomId: 100, unitId: 1, firstNight: '2026-09-05', lastNight: '2026-09-09', status: 'new' },
      lookup
    );
    expect(booking.checkoutDate).toBe('2026-09-10');
    expect(booking.startDate).toBe('2026-09-05');
  });

  it('日時つきの日付でも日付部分だけを取る', () => {
    const { booking } = toAppBooking(
      { id: 1, roomId: 100, unitId: 1, arrival: '2026-09-05T15:00:00', departure: '2026-09-10T10:00:00', status: '' },
      lookup
    );
    expect(booking.startDate).toBe('2026-09-05');
    expect(booking.checkoutDate).toBe('2026-09-10');
  });

  it('unitId が空の部屋も引ける', () => {
    const { booking } = toAppBooking(
      { id: 5, roomId: 200, arrival: '2026-09-01', departure: '2026-09-03', status: '' },
      lookup
    );
    expect(booking.unit).toBe('s1');
  });
});

describe('認証', () => {
  it('招待コードでリフレッシュトークンを保存できる', async () => {
    const fetchImpl = stubFetch([
      ['/authentication/setup', () => jsonResponse({ refreshToken: 'refresh-1', token: 'access-1', expiresIn: 86400 })]
    ]);

    await connectWithInviteCode(db, ENC_KEY, 'invite-code', { fetch: fetchImpl });

    expect(fetchImpl.calls[0].headers.code).toBe('invite-code');
    expect(await getRefreshToken(db, ENC_KEY)).toBe('refresh-1');

    const status = await getAuthStatus(db);
    expect(status.state).toBe(STATE.CONNECTED);
    expect(status.hasToken).toBe(true);
  });

  it('トークンは暗号化して保存される（DBに平文で残らない）', async () => {
    const fetchImpl = stubFetch([
      ['/authentication/setup', () => jsonResponse({ refreshToken: 'secret-token-value', token: 'a', expiresIn: 60 })]
    ]);
    await connectWithInviteCode(db, ENC_KEY, 'code', { fetch: fetchImpl });

    const raw = await db.prepare('SELECT refresh_token_enc FROM beds24_auth WHERE id = 1').first('refresh_token_enc');
    expect(raw).not.toContain('secret-token-value');
    expect(raw).toContain(':'); // iv:暗号文 の形
  });

  it('期限内のアクセストークンは再取得しない', async () => {
    const fetchImpl = stubFetch([
      ['/authentication/setup', () => jsonResponse({ refreshToken: 'r', token: 'access-1', expiresIn: 86400 })],
      ['/authentication/token', () => jsonResponse({ token: 'access-2', expiresIn: 86400 })]
    ]);

    await connectWithInviteCode(db, ENC_KEY, 'code', { fetch: fetchImpl });
    const token = await getAccessToken(db, ENC_KEY, {}, { fetch: fetchImpl });

    expect(token).toBe('access-1');
    expect(fetchImpl.calls).toHaveLength(1); // setup の1回だけ
  });

  it('force を指定すると必ず取り直す（30日失効を防ぐキープアライブ用）', async () => {
    const fetchImpl = stubFetch([
      ['/authentication/setup', () => jsonResponse({ refreshToken: 'r', token: 'access-1', expiresIn: 86400 })],
      ['/authentication/token', () => jsonResponse({ token: 'access-2', refreshToken: 'r2', expiresIn: 86400 })]
    ]);

    await connectWithInviteCode(db, ENC_KEY, 'code', { fetch: fetchImpl });
    const token = await getAccessToken(db, ENC_KEY, { force: true }, { fetch: fetchImpl });

    expect(token).toBe('access-2');
    // ローテーションされた新しいリフレッシュトークンが保存されている
    expect(await getRefreshToken(db, ENC_KEY)).toBe('r2');
  });

  it('401 は失効として扱い、再接続が必要な状態にする', async () => {
    const fetchImpl = stubFetch([
      ['/authentication/setup', () => jsonResponse({ refreshToken: 'r', token: 't', expiresIn: 0 })],
      ['/authentication/token', () => jsonResponse({ error: 'unauthorized' }, 401)]
    ]);

    await connectWithInviteCode(db, ENC_KEY, 'code', { fetch: fetchImpl });
    await expect(getAccessToken(db, ENC_KEY, {}, { fetch: fetchImpl })).rejects.toThrow(/失効/);

    const status = await getAuthStatus(db);
    expect(status.state).toBe(STATE.NEEDS_RECONNECT);
    // 失効しても、再接続の手がかりとしてトークン自体は消さない
    expect(status.hasToken).toBe(true);
  });

  it('500 は一時的な障害として扱う（失効とは区別する）', async () => {
    const fetchImpl = stubFetch([
      ['/authentication/setup', () => jsonResponse({ refreshToken: 'r', token: 't', expiresIn: 0 })],
      ['/authentication/token', () => jsonResponse({ error: 'oops' }, 500)]
    ]);

    await connectWithInviteCode(db, ENC_KEY, 'code', { fetch: fetchImpl });
    await expect(getAccessToken(db, ENC_KEY, {}, { fetch: fetchImpl })).rejects.toThrow(/一時的/);

    expect((await getAuthStatus(db)).state).toBe(STATE.ERROR);
  });

  it('未接続なら分かりやすいエラーを返す', async () => {
    await expect(getAccessToken(db, ENC_KEY, {}, { fetch: stubFetch([]) })).rejects.toThrow(/接続されていません/);
  });
});

describe('予約の取得', () => {
  async function connect(fetchImpl) {
    await connectWithInviteCode(db, ENC_KEY, 'code', { fetch: fetchImpl });
  }

  const booking = (id, unitId, checkout) => ({
    id,
    roomId: 100,
    unitId,
    arrival: '2026-09-01',
    departure: checkout,
    numAdult: 2,
    status: 'confirmed'
  });

  it('取得してこのアプリの形で返す', async () => {
    const fetchImpl = stubFetch([
      ['/authentication/setup', () => jsonResponse({ refreshToken: 'r', token: 't', expiresIn: 86400 })],
      ['/bookings', () => jsonResponse([booking(1, 1, '2026-09-10'), booking(2, 2, '2026-09-11')])]
    ]);
    await connect(fetchImpl);

    const result = await fetchBookings(db, ENC_KEY, { today: '2026-09-08', fetchDays: 90 }, { fetch: fetchImpl });

    expect(result.bookings.map((b) => b.unit)).toEqual(['b4', 'b5']);
    expect(result.range).toEqual({ from: '2026-09-08', to: '2026-12-07' });
  });

  it('100件ちょうどなら次のページも取りに行く', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => booking(i + 1, 1, '2026-09-10'));
    const fetchImpl = stubFetch([
      ['/authentication/setup', () => jsonResponse({ refreshToken: 'r', token: 't', expiresIn: 86400 })],
      ['/bookings', (url) => jsonResponse(url.includes('page=1') ? page1 : [booking(999, 2, '2026-09-12')])]
    ]);
    await connect(fetchImpl);

    const result = await fetchBookings(
      db,
      ENC_KEY,
      { today: '2026-09-08', fetchDays: 90 },
      { fetch: fetchImpl, sleep: async () => {} }
    );

    expect(result.pages).toBe(2);
    expect(result.bookings).toHaveLength(101);
  });

  it('マッピングされていない部屋は取り込まず、一覧に残す', async () => {
    const fetchImpl = stubFetch([
      ['/authentication/setup', () => jsonResponse({ refreshToken: 'r', token: 't', expiresIn: 86400 })],
      [
        '/bookings',
        () => jsonResponse([booking(1, 1, '2026-09-10'), { ...booking(2, 9, '2026-09-11'), roomId: 777 }])
      ]
    ]);
    await connect(fetchImpl);

    const result = await fetchBookings(db, ENC_KEY, { today: '2026-09-08', fetchDays: 90 }, { fetch: fetchImpl });

    expect(result.bookings).toHaveLength(1);
    expect(result.skipped.unmapped).toBe(1);
    expect(result.unmappedRooms).toEqual(['777:9']);
  });

  it('ユニットマッピングが未設定ならエラーにする', async () => {
    await db.prepare('DELETE FROM unit_map').run();
    const fetchImpl = stubFetch([
      ['/authentication/setup', () => jsonResponse({ refreshToken: 'r', token: 't', expiresIn: 86400 })]
    ]);
    await connect(fetchImpl);

    await expect(
      fetchBookings(db, ENC_KEY, { today: '2026-09-08', fetchDays: 90 }, { fetch: fetchImpl })
    ).rejects.toThrow(/ユニットマッピングが未設定/);
  });
});

describe('日次処理（取得から割り当てまで）', () => {
  const NOW = Date.parse('2026-09-08T21:00:00Z'); // JST 2026-09-09 06:00

  function stubApi(bookings) {
    return stubFetch([
      ['/authentication/setup', () => jsonResponse({ refreshToken: 'r', token: 't', expiresIn: 86400 })],
      ['/bookings', () => jsonResponse(bookings)]
    ]);
  }

  it('取得 → 保存 → 割り当て → 実行ログまで通る', async () => {
    const fetchImpl = stubApi([
      {
        id: 1,
        roomId: 100,
        unitId: 1,
        arrival: '2026-09-05',
        departure: '2026-09-10',
        numAdult: 2,
        status: 'confirmed'
      },
      {
        id: 2,
        roomId: 100,
        unitId: 2,
        arrival: '2026-09-06',
        departure: '2026-09-10',
        numAdult: 4,
        status: 'confirmed'
      }
    ]);
    await connectWithInviteCode(db, ENC_KEY, 'code', { fetch: fetchImpl });

    // 細田さんが 9/10 に1件だけ対応できる状態にする
    const hosoda = await getStaffByName(db, '細田さん');
    await setCapacityBulk(db, hosoda.id, [{ date: '2026-09-10', capacity: 1 }]);

    const result = await runDaily({ DB: db, TOKEN_ENC_KEY: ENC_KEY }, { kind: 'manual', now: NOW, fetchImpl });

    expect(result.ok).toBe(true);
    expect(await listActiveBookings(db)).toHaveLength(2);

    const assignments = await listAssignments(db);
    expect(assignments).toHaveLength(2);

    // 1件は細田さん、もう1件は外注（14日以内なので）
    const staffNames = assignments.map((a) => a.staffName).sort();
    expect(staffNames).toEqual(['Rクリーン', '細田さん']);

    const runs = await listRuns(db);
    expect(runs[0].ok).toBe(1);
    expect(runs[0].fetched).toBe(2);
  });

  it('実行日は JST で決まる（UTC 21時は翌日）', async () => {
    const fetchImpl = stubApi([]);
    await connectWithInviteCode(db, ENC_KEY, 'code', { fetch: fetchImpl });

    await runDaily({ DB: db, TOKEN_ENC_KEY: ENC_KEY }, { kind: 'cron', now: NOW, fetchImpl });

    // 取得範囲の開始日が JST の「今日」になっている
    const bookingsCall = fetchImpl.calls.find((c) => c.url.includes('/bookings'));
    expect(bookingsCall.url).toContain('departure_from=2026-09-09');
  });

  it('取得0件なら割り当てをせず、通知を残す', async () => {
    const fetchImpl = stubApi([]);
    await connectWithInviteCode(db, ENC_KEY, 'code', { fetch: fetchImpl });

    const result = await runDaily({ DB: db, TOKEN_ENC_KEY: ENC_KEY }, { now: NOW, fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('zero_bookings');

    const notices = await listUnacknowledged(db);
    expect(notices.map((n) => n.kind)).toContain('zero_bookings');
  });

  it('未割当があれば通知を残す', async () => {
    // 出勤可能件数を誰も入れていない → 15日以上先は未割当のまま
    const fetchImpl = stubApi([
      {
        id: 1,
        roomId: 100,
        unitId: 1,
        arrival: '2026-10-01',
        departure: '2026-10-05',
        numAdult: 2,
        status: 'confirmed'
      }
    ]);
    await connectWithInviteCode(db, ENC_KEY, 'code', { fetch: fetchImpl });

    await runDaily({ DB: db, TOKEN_ENC_KEY: ENC_KEY }, { now: NOW, fetchImpl });

    const notices = await listUnacknowledged(db);
    expect(notices.map((n) => n.kind)).toContain('unassigned');
  });

  it('Beds24 が失効していたら、実行ログと通知の両方に残す', async () => {
    const fetchImpl = stubFetch([
      ['/authentication/setup', () => jsonResponse({ refreshToken: 'r', token: 't', expiresIn: 0 })],
      ['/authentication/token', () => jsonResponse({ error: 'unauthorized' }, 401)]
    ]);
    // 接続時と実行時で時刻を揃える（揃えないとキャッシュ判定がずれる）
    await connectWithInviteCode(db, ENC_KEY, 'code', { fetch: fetchImpl, now: () => NOW });

    const result = await runDaily({ DB: db, TOKEN_ENC_KEY: ENC_KEY }, { now: NOW, fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.permanent).toBe(true);

    const runs = await listRuns(db);
    expect(runs[0].ok).toBe(0);
    expect(runs[0].error).toMatch(/失効/);

    const notices = await listUnacknowledged(db);
    const authNotice = notices.find((n) => n.kind === 'auth_expired');
    expect(authNotice).toBeTruthy();
    expect(authNotice.body).toMatch(/招待コード/); // 復旧手順が書いてある
  });

  it('2回実行しても割り当てが重複しない（前回の担当を引き継ぐ）', async () => {
    const fetchImpl = stubApi([
      {
        id: 1,
        roomId: 100,
        unitId: 1,
        arrival: '2026-09-05',
        departure: '2026-09-10',
        numAdult: 2,
        status: 'confirmed'
      }
    ]);
    await connectWithInviteCode(db, ENC_KEY, 'code', { fetch: fetchImpl });

    const hosoda = await getStaffByName(db, '細田さん');
    await setCapacityBulk(db, hosoda.id, [{ date: '2026-09-10', capacity: 1 }]);

    await runDaily({ DB: db, TOKEN_ENC_KEY: ENC_KEY }, { now: NOW, fetchImpl });
    const first = await listAssignments(db);

    await runDaily({ DB: db, TOKEN_ENC_KEY: ENC_KEY }, { now: NOW, fetchImpl });
    const second = await listAssignments(db);

    expect(second).toHaveLength(1);
    expect(second[0].staffName).toBe(first[0].staffName);
  });
});
