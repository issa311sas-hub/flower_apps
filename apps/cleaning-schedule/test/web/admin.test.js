/**
 * 管理画面（Beds24接続・ユニット対応づけ・手動実行）のテスト
 *
 * 本物の Beds24 は叩かず、応答を差し替えて検証する。
 *
 * ここで一番大事なのは**対応づけ（unit_map）**。これが壊れると予約を1件も
 * 取り込めず、しかも画面上は「予定なし」に見えてしまい原因に気づけない。
 * 保存で既存の対応が消えないことを重点的に確認する。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/index.js';
import { createTestDb } from '../support/d1-sqlite.js';
import { createUser } from '../../src/db/users.js';
import { getStaffByName } from '../../src/db/staff.js';
import { listUnitMap, replaceUnitMap } from '../../src/db/units.js';
import { getAuthStatus, getRefreshToken, STATE } from '../../src/db/beds24Auth.js';
import { setCapacityBulk } from '../../src/db/availability.js';
import { listAssignments } from '../../src/db/assignments.js';
import { listRuns } from '../../src/db/runs.js';
import { showBeds24, connectBeds24, discoverUnits, saveUnitMap } from '../../src/web/pages/beds24.js';
import { runNow, showRun } from '../../src/web/pages/runs.js';

const ORIGIN = 'https://cleaning.example.workers.dev';
const PEPPER = 'test-pepper';
const ENC_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const FAST = { pepper: PEPPER, iterations: 1000 };

/** 2026-09-10 09:00 JST（jstToday は 2026-09-10 になる） */
const NOW = Date.parse('2026-09-10T00:00:00Z');
const INVITE_CODE = 'invite-code-do-not-leak';

let env;
let cookie;

beforeEach(async () => {
  env = { DB: createTestDb(), SESSION_PEPPER: PEPPER, TOKEN_ENC_KEY: ENC_KEY };
  cookie = await loginAsAdmin();
});

async function loginAsAdmin() {
  const created = await createUser(
    env.DB,
    { loginId: 'owner', displayName: '経営者', role: 'admin', mustChange: false },
    FAST
  );
  const res = await worker.fetch(post('/login', { login_id: 'owner', password: created.password }), env);
  return (res.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0];
}

function get(path, cookieValue = cookie) {
  return new Request(`${ORIGIN}${path}`, { headers: cookieValue ? { cookie: cookieValue } : {} });
}

function post(path, body, { cookie: cookieValue, origin = ORIGIN } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (cookieValue) headers.cookie = cookieValue;
  if (origin !== null) headers.origin = origin;

  const params = Array.isArray(body) ? new URLSearchParams(body) : new URLSearchParams(body);
  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body: params.toString() });
}

/** fetch の代わり。呼ばれたURLとヘッダを記録する */
function stubFetch(handlers) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    for (const [pattern, respond] of handlers) {
      if (String(url).includes(pattern)) return respond(String(url), init);
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

/** 招待コードでの接続に成功する fetch。
 *  接続は setup のあとリフレッシュも1回試すので、両方が通る必要がある。 */
function connectOk() {
  return stubFetch([
    [
      '/authentication/setup',
      () => jsonResponse({ refreshToken: 'refresh-1', token: 'access-1', expiresIn: 86400 })
    ],
    ['/authentication/token', () => jsonResponse({ token: 'access-2', expiresIn: 86400 })]
  ]);
}

async function connect(fetchImpl = connectOk()) {
  return connectBeds24(post('/admin/beds24', { invite_code: INVITE_CODE }, { cookie }), env, {
    fetchImpl,
    now: NOW
  });
}

// ------------------------------------------------------------------

describe('Beds24 の接続', () => {
  // ------------------------------------------------------------------
  // 接続直後に、リフレッシュが通ることまで確かめる
  //
  // setup が返すアクセストークンは24時間有効なので、接続直後は何をしても動く。
  // 明日以降も動くかを決めるのはリフレッシュトークンで、それはキャッシュが
  // ある間は一度も試されない。実際に、接続して6回の実行がすべて成功した
  // 翌日に、初めてその経路を通った見張りが失効を見つけた。
  // ------------------------------------------------------------------

  it('★リフレッシュが通らなければ「接続できました」と言わない', async () => {
    const fetchImpl = stubFetch([
      [
        '/authentication/setup',
        () => jsonResponse({ refreshToken: 'refresh-1', token: 'access-1', expiresIn: 86400 })
      ],
      ['/authentication/token', () => jsonResponse({ error: 'unauthorized' }, 401)]
    ]);

    const res = await connect(fetchImpl);

    expect(res.status).not.toBe(303);
    const body = await res.text();
    expect(body).toContain('トークンの更新に失敗');
    expect(body).toContain('明日以降');
  });

  it('リフレッシュに失敗しても、トークンは保存したままにする（今日の分は動く）', async () => {
    const fetchImpl = stubFetch([
      [
        '/authentication/setup',
        () => jsonResponse({ refreshToken: 'refresh-1', token: 'access-1', expiresIn: 86400 })
      ],
      ['/authentication/token', () => jsonResponse({ error: 'unauthorized' }, 401)]
    ]);

    await connect(fetchImpl);

    // 消してしまうと、24時間有効なアクセストークンまで捨てることになる
    expect(await getRefreshToken(env.DB, ENC_KEY)).toBe('refresh-1');
  });

  it('接続では setup のあとリフレッシュも1回試す', async () => {
    const fetchImpl = connectOk();
    await connect(fetchImpl);

    expect(fetchImpl.calls.some((c) => c.url.includes('/authentication/setup'))).toBe(true);
    expect(fetchImpl.calls.some((c) => c.url.includes('/authentication/token'))).toBe(true);
  });

  it('招待コードで接続でき、トークンは暗号化して保存される', async () => {
    const fetchImpl = connectOk();
    const res = await connect(fetchImpl);

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/beds24?connected=1');

    // 招待コードはヘッダで渡す（URLに載せない）
    expect(fetchImpl.calls[0].headers.code).toBe(INVITE_CODE);

    const status = await getAuthStatus(env.DB, NOW);
    expect(status.state).toBe(STATE.CONNECTED);
    expect(status.hasToken).toBe(true);

    // 復号すれば取り出せるが、DBの生の値はトークンそのものではない
    expect(await getRefreshToken(env.DB, ENC_KEY)).toBe('refresh-1');
    const stored = await env.DB.prepare('SELECT refresh_token_enc FROM beds24_auth WHERE id = 1').first('refresh_token_enc');
    expect(stored).not.toContain('refresh-1');
  });

  it('招待コードは画面にもDBにも残らない', async () => {
    await connect();

    const page = await (await showBeds24(get('/admin/beds24'), env, { now: NOW })).text();
    expect(page).not.toContain(INVITE_CODE);

    const dump = JSON.stringify([
      (await env.DB.prepare('SELECT * FROM beds24_auth').all()).results,
      (await env.DB.prepare('SELECT * FROM runs').all()).results,
      (await env.DB.prepare('SELECT * FROM notifications').all()).results
    ]);
    expect(dump).not.toContain(INVITE_CODE);
  });

  it('401 は「要再接続」として記録され、画面にも出る', async () => {
    const fetchImpl = stubFetch([['/authentication/setup', () => jsonResponse({ message: 'invalid code' }, 401)]]);
    const res = await connect(fetchImpl);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('接続に失敗しました');

    const status = await getAuthStatus(env.DB, NOW);
    expect(status.state).toBe(STATE.NEEDS_RECONNECT);
    expect(status.hasToken).toBe(false);
  });

  it('招待コードが空なら Beds24 を呼ばない', async () => {
    const fetchImpl = stubFetch([]);
    const res = await connectBeds24(post('/admin/beds24', { invite_code: '  ' }, { cookie }), env, { fetchImpl });

    expect(res.status).toBe(400);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('鍵が登録されていなければ接続フォームを出さない', async () => {
    const noKey = { ...env, TOKEN_ENC_KEY: undefined };
    const body = await (await showBeds24(get('/admin/beds24'), noKey, { now: NOW })).text();

    expect(body).toContain('先に秘密の鍵（TOKEN_ENC_KEY）を登録してください');
    expect(body).not.toContain('name="invite_code"');
  });
});

describe('ユニットの対応づけ', () => {
  const discovered = [
    { roomId: '100', unitId: '1', roomName: 'Beach', unitName: 'A', count: 12 },
    { roomId: '100', unitId: '2', roomName: 'Beach', unitName: 'B', count: 7 },
    { roomId: '200', unitId: '', roomName: 'Sea', unitName: '', count: 3 }
  ];

  function discoverOk(rows = discovered) {
    return stubFetch([
      [
        '/bookings',
        () =>
          jsonResponse(
            rows.flatMap((r) =>
              Array.from({ length: r.count }, () => ({
                roomId: Number(r.roomId),
                unitId: r.unitId === '' ? null : Number(r.unitId),
                roomName: r.roomName,
                unitName: r.unitName
              }))
            )
          )
      ]
    ]);
  }

  async function discover(fetchImpl = discoverOk()) {
    await connect();
    return discoverUnits(post('/admin/beds24/discover', {}, { cookie }), env, { fetchImpl, now: NOW });
  }

  it('予約に出てくる部屋の一覧と件数を表示する', async () => {
    const body = await (await discover()).text();

    expect(body).toContain('100:1');
    expect(body).toContain('200:');
    expect(body).toContain('12件');
    // どのユニットに当てるか選べる
    expect(body).toContain('<option value="b4"');
  });

  it('選んだ対応づけを保存できる', async () => {
    const res = await saveUnitMap(
      post(
        '/admin/beds24/map',
        [
          ['room_id', '100'], ['unit_id', '1'], ['unit_name', 'b4'],
          ['room_id', '100'], ['unit_id', '2'], ['unit_name', 'b5'],
          ['room_id', '200'], ['unit_id', ''], ['unit_name', 's1']
        ],
        { cookie }
      ),
      env
    );

    expect(res.headers.get('location')).toBe('/admin/beds24?mapped=1');
    expect(await listUnitMap(env.DB)).toEqual([
      { roomId: '100', unitId: '1', unitName: 'b4', note: null },
      { roomId: '100', unitId: '2', unitName: 'b5', note: null },
      { roomId: '200', unitId: '', unitName: 's1', note: null }
    ]);
  });

  it('「使わない」を選んだ行と、存在しないユニット名は保存しない', async () => {
    await saveUnitMap(
      post(
        '/admin/beds24/map',
        [
          ['room_id', '100'], ['unit_id', '1'], ['unit_name', 'b4'],
          ['room_id', '100'], ['unit_id', '2'], ['unit_name', ''],
          ['room_id', '300'], ['unit_id', '9'], ['unit_name', 'そんなユニットはない']
        ],
        { cookie }
      ),
      env
    );

    expect(await listUnitMap(env.DB)).toEqual([{ roomId: '100', unitId: '1', unitName: 'b4', note: null }]);
  });

  it('取得期間に予約が無い部屋も画面に残り、保存しても消えない', async () => {
    // 「c4」は登録済みだが、今回の取得結果には出てこない
    await replaceUnitMap(env.DB, [
      { roomId: '100', unitId: '1', unitName: 'b4' },
      { roomId: '999', unitId: '5', unitName: 'c4' }
    ]);

    const body = await (await discover()).text();
    expect(body).toContain('999:5');
    expect(body).toContain('今回は出てきません');
    // 既存の対応は選択済みで出る
    expect(body).toMatch(/<option value="c4" selected>/);

    // 画面に出ている行をそのまま送り返せば、消えない
    await saveUnitMap(
      post(
        '/admin/beds24/map',
        [
          ['room_id', '100'], ['unit_id', '1'], ['unit_name', 'b4'],
          ['room_id', '100'], ['unit_id', '2'], ['unit_name', ''],
          ['room_id', '200'], ['unit_id', ''], ['unit_name', ''],
          ['room_id', '999'], ['unit_id', '5'], ['unit_name', 'c4']
        ],
        { cookie }
      ),
      env
    );

    const map = await listUnitMap(env.DB);
    expect(map.map((r) => r.unitName).sort()).toEqual(['b4', 'c4']);
  });
});

describe('手動実行', () => {
  it('対応づけ後に実行すると、予約が取り込まれて担当が決まる', async () => {
    await connect();
    await replaceUnitMap(env.DB, [{ roomId: '100', unitId: '1', unitName: 'b4' }]);

    const hosoda = await getStaffByName(env.DB, '細田さん');
    await setCapacityBulk(env.DB, hosoda.id, [{ date: '2026-09-12', capacity: 2 }]);

    const fetchImpl = stubFetch([
      [
        '/bookings',
        () =>
          jsonResponse([
            {
              id: 555,
              roomId: 100,
              unitId: 1,
              guestTitle: '消毒ポット',
              arrival: '2026-09-08',
              departure: '2026-09-12',
              numAdult: 2,
              status: 'confirmed'
            }
          ])
      ]
    ]);

    const res = await runNow(post('/admin/run', {}, { cookie }), env, { fetchImpl, now: NOW, sleep: async () => {} });

    expect(res.status).toBe(303);
    const runId = Number(res.headers.get('location').split('/').pop());

    const rows = await listAssignments(env.DB);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      bookingId: '555',
      unit: 'b4',
      checkoutDate: '2026-09-12',
      cleaningDate: '2026-09-12',
      staffName: '細田さん'
    });

    // 誰が実行したかが残る
    const runs = await listRuns(env.DB);
    expect(runs[0].kind).toBe('manual');
    expect(runs[0].triggered_by).toBe('owner');
    expect(runs[0].ok).toBe(1);

    const detail = await (await showRun(get(`/admin/runs/${runId}`), env, { id: String(runId) })).text();
    expect(detail).toContain('取得 1件');
    expect(detail).toContain('正常');
  });

  it('対応づけが無ければ失敗として記録され、詳細に理由が出る', async () => {
    await connect();

    const fetchImpl = stubFetch([['/bookings', () => jsonResponse([])]]);
    const res = await runNow(post('/admin/run', {}, { cookie }), env, { fetchImpl, now: NOW, sleep: async () => {} });

    const runId = Number(res.headers.get('location').split('/').pop());
    const detail = await (await showRun(get(`/admin/runs/${runId}`), env, { id: String(runId) })).text();

    expect(detail).toContain('失敗');
    expect(detail).toContain('ユニットマッピングが未設定です');
  });
});

describe('アクセス制御', () => {
  async function staffCookie() {
    const staff = await getStaffByName(env.DB, '細田さん');
    const created = await createUser(
      env.DB,
      { loginId: 'hosoda', displayName: '細田さん', role: 'staff', staffId: staff.id, mustChange: false },
      FAST
    );
    const res = await worker.fetch(post('/login', { login_id: 'hosoda', password: created.password }), env);
    return (res.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0];
  }

  it('スタッフは管理画面のどのページにも入れない', async () => {
    const sid = await staffCookie();

    for (const path of ['/admin/beds24', '/admin/assignments', '/admin/runs']) {
      const res = await worker.fetch(get(path, sid), env);
      expect(res.headers.get('location')).toBe('/me');
    }
  });

  it('スタッフは接続も対応づけの保存もできない', async () => {
    const sid = await staffCookie();
    await replaceUnitMap(env.DB, [{ roomId: '100', unitId: '1', unitName: 'b4' }]);

    const res = await worker.fetch(
      post('/admin/beds24/map', [['room_id', '1'], ['unit_id', '1'], ['unit_name', 'b5']], { cookie: sid }),
      env
    );

    expect(res.headers.get('location')).toBe('/me');
    expect(await listUnitMap(env.DB)).toHaveLength(1);
  });

  it('Origin の無いPOSTは拒否する', async () => {
    const res = await saveUnitMap(
      post('/admin/beds24/map', [['room_id', '1'], ['unit_id', '1'], ['unit_name', 'b4']], {
        cookie,
        origin: null
      }),
      env
    );

    expect(res.status).toBe(403);
    expect(await listUnitMap(env.DB)).toHaveLength(0);
  });

  it('ルーティングが繋がっている（未ログインならログイン画面へ）', async () => {
    for (const path of ['/admin/beds24', '/admin/assignments', '/admin/runs', '/admin/runs/1']) {
      const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env);
      expect(res.headers.get('location')).toContain('/login');
    }
  });
});

describe('割り当て一覧', () => {
  it('未割当が何件あるかを最初に伝える', async () => {
    const res = await worker.fetch(get('/admin/assignments'), env);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain('未割当 0件');
    expect(body).toContain('この期間の予定はありません');
  });
});
