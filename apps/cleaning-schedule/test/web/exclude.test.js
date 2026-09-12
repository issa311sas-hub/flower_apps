/**
 * 対象外の予約を、日次処理と画面まで通して確かめるテスト
 *
 * ダミー予約に担当が付くと、実在しない清掃がスタッフの予定に出る。
 * さらに外注に回れば、そのまま費用になる。**外注に回らないこと**を明示的に固定する。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/index.js';
import { createTestDb } from '../support/d1-sqlite.js';
import { createUser } from '../../src/db/users.js';
import { getStaffByName } from '../../src/db/staff.js';
import { replaceUnitMap } from '../../src/db/units.js';
import { setCapacityBulk } from '../../src/db/availability.js';
import { listAssignments } from '../../src/db/assignments.js';
import { saveTokens } from '../../src/db/beds24Auth.js';
import { setSetting } from '../../src/db/settings.js';
import { runDaily } from '../../src/jobs/dailyRun.js';

const ORIGIN = 'https://cleaning.example.workers.dev';
const PEPPER = 'test-pepper';
const ENC_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const FAST = { pepper: PEPPER, iterations: 1000 };

/** 2026-09-10 09:00 JST */
const NOW = Date.parse('2026-09-10T00:00:00Z');
const CHECKOUT = '2026-09-12';

let env;
let cookie;

beforeEach(async () => {
  env = { DB: createTestDb(), SESSION_PEPPER: PEPPER, TOKEN_ENC_KEY: ENC_KEY };
  await replaceUnitMap(env.DB, [
    { roomId: '100', unitId: '1', unitName: 'b4' },
    { roomId: '100', unitId: '2', unitName: 'b5' }
  ]);
  await saveTokens(env.DB, ENC_KEY, { refreshToken: 'r', accessToken: 'a', expiresInSec: 86400 });

  const created = await createUser(
    env.DB,
    { loginId: 'owner', displayName: '経営者', role: 'admin', mustChange: false },
    FAST
  );
  const res = await worker.fetch(post('/login', { login_id: 'owner', password: created.password }), env);
  cookie = (res.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0];
});

function get(path) {
  return new Request(`${ORIGIN}${path}`, { headers: { cookie } });
}

function post(path, body) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN };
  // ログイン時はまだ cookie が無い。それ以外は付ける
  if (cookie) headers.cookie = cookie;
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body).toString()
  });
}

/** Beds24 の代わり。予約2件（本物とダミー）を返す */
const beds24 = (titles) => async (url) => {
  if (String(url).includes('/authentication/')) {
    return { ok: true, status: 200, json: async () => ({ token: 'a', expiresIn: 86400 }), text: async () => '' };
  }
  return {
    ok: true,
    status: 200,
    json: async () => [
      { id: 1, roomId: 100, unitId: 1, guestTitle: titles[0], arrival: '2026-09-08', departure: CHECKOUT, numAdult: 2, status: 'confirmed' },
      { id: 2, roomId: 100, unitId: 2, guestTitle: titles[1], arrival: '2026-09-08', departure: CHECKOUT, numAdult: 2, status: 'confirmed' }
    ],
    text: async () => ''
  };
};

const run = (titles) => runDaily(env, { kind: 'manual', now: NOW, fetchImpl: beds24(titles), sleep: async () => {} });

/** 細田さんが2件受けられる状態にする */
async function openCapacity(n = 2) {
  const hosoda = await getStaffByName(env.DB, '細田さん');
  await setCapacityBulk(env.DB, hosoda.id, [{ date: CHECKOUT, capacity: n }]);
}

describe('対象外の予約', () => {
  it('★語句を登録していなければ、従来どおり両方に担当が付く', async () => {
    await openCapacity();
    await run(['消毒ポット', 'テスト予約']);

    const rows = await listAssignments(env.DB, { from: CHECKOUT, to: CHECKOUT });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.staffName === '細田さん')).toBe(true);
  });

  it('★一致した予約には担当が付かず、「対象外」で残る', async () => {
    await setSetting(env.DB, 'exclude_title_words', 'テスト');
    await openCapacity();
    await run(['消毒ポット', 'テスト予約']);

    const rows = await listAssignments(env.DB, { from: CHECKOUT, to: CHECKOUT });
    const byId = new Map(rows.map((r) => [r.bookingId, r]));

    expect(byId.get('2').staffName).toBe('対象外');
    expect(byId.get('2').status).toBe('対象外');
    expect(byId.get('1').staffName).toBe('細田さん');
  });

  it('★対象外の予約は外注にも回らない（そのまま費用になるため）', async () => {
    await setSetting(env.DB, 'exclude_title_words', 'テスト');
    // 誰も出勤しない ＝ 本来なら外注に回る状況
    await run(['テスト予約A', 'テスト予約B']);

    const rows = await listAssignments(env.DB, { from: CHECKOUT, to: CHECKOUT });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.staffName === '対象外')).toBe(true);
    expect(rows.some((r) => r.staffName === 'Rクリーン')).toBe(false);
  });

  it('★残りの予約の割り当ては、除外が無かった場合と変わらない', async () => {
    await openCapacity(1);
    await run(['消毒ポット', 'ふつうの予約']);
    const before = (await listAssignments(env.DB, { from: CHECKOUT, to: CHECKOUT })).find((r) => r.bookingId === '1');

    // 入れ直して、もう片方だけを対象外にする
    env.DB = createTestDb();
    await replaceUnitMap(env.DB, [
      { roomId: '100', unitId: '1', unitName: 'b4' },
      { roomId: '100', unitId: '2', unitName: 'b5' }
    ]);
    await saveTokens(env.DB, ENC_KEY, { refreshToken: 'r', accessToken: 'a', expiresInSec: 86400 });
    await setSetting(env.DB, 'exclude_title_words', 'ふつう');
    await openCapacity(1);
    await run(['消毒ポット', 'ふつうの予約']);
    const after = (await listAssignments(env.DB, { from: CHECKOUT, to: CHECKOUT })).find((r) => r.bookingId === '1');

    expect(after.staffName).toBe(before.staffName);
    expect(after.cleaningDate).toBe(before.cleaningDate);
    expect(after.status).toBe(before.status);
  });

  it('実行ログに件数が出る', async () => {
    await setSetting(env.DB, 'exclude_title_words', 'テスト');
    await openCapacity();
    const result = await run(['消毒ポット', 'テスト予約']);

    expect(result.message).toContain('対象外 1件');
  });

  it('件数が0のときは実行ログに書かない（余計な文字を増やさない）', async () => {
    await openCapacity();
    const result = await run(['消毒ポット', 'ふつうの予約']);

    expect(result.message).not.toContain('対象外');
  });

  it('割り当て一覧に「対象外」として薄く出る', async () => {
    await setSetting(env.DB, 'exclude_title_words', 'テスト');
    await openCapacity();
    await run(['消毒ポット', 'テスト予約']);

    const body = await (await worker.fetch(get(`/admin/assignments?from=${CHECKOUT}&to=${CHECKOUT}`), env)).text();
    expect(body).toContain('class="excluded"');
    expect(body).toContain('対象外 1件');
  });

  it('カレンダーにも出る', async () => {
    await setSetting(env.DB, 'exclude_title_words', 'テスト');
    await openCapacity();
    await run(['消毒ポット', 'テスト予約']);

    const body = await (await worker.fetch(get('/admin/assignments?view=calendar&month=2026-09'), env)).text();
    expect(body).toContain('job-excluded');
  });

  it('タイムラインにも出る', async () => {
    await setSetting(env.DB, 'exclude_title_words', 'テスト');
    await openCapacity();
    await run(['消毒ポット', 'テスト予約']);

    const body = await (await worker.fetch(get(`/admin/timeline?from=${CHECKOUT}&days=7`), env)).text();
    expect(body).toContain('cell-excluded');
  });
});

describe('設定画面の安全装置', () => {
  it('語句が未登録なら、その旨を出す', async () => {
    const body = await (await worker.fetch(get('/admin/settings'), env)).text();
    expect(body).toContain('語句が登録されていないので');
  });

  it('★一致する予約の件数と中身を出す（本物を巻き込んでいないか確かめられる）', async () => {
    await setSetting(env.DB, 'exclude_title_words', 'テスト');
    await openCapacity();
    await run(['消毒ポット', 'テスト予約']);

    const body = await (await worker.fetch(get('/admin/settings'), env)).text();
    expect(body).toContain('1件 が対象外になります');
    expect(body).toContain('テスト予約');
    expect(body).not.toContain('消毒ポット');
  });

  it('一致が無ければ、その旨を出す', async () => {
    await setSetting(env.DB, 'exclude_title_words', '出てこない語');
    await openCapacity();
    await run(['消毒ポット', 'ふつうの予約']);

    const body = await (await worker.fetch(get('/admin/settings'), env)).text();
    expect(body).toContain('一致するものはありません');
  });

  it('設定画面から保存できる', async () => {
    await worker.fetch(post('/admin/settings', { exclude_title_words: 'テスト\n\nダミー  ' }), env);

    const saved = await env.DB.prepare("SELECT value FROM settings WHERE key = 'exclude_title_words'").first('value');
    expect(saved).toBe('テスト\nダミー');
  });
});

// ------------------------------------------------------------------
// あとからタイトルが変わった場合
//
// Beds24 側でタイトルにダミーの語句を足すと、次の実行で対象外になる。
// そのとき**空いた枠が割り振り直される**ことまでを通しで確かめる。
// ここが通らないと、ダミーを外しても外注費は減らない。
// ------------------------------------------------------------------

describe('あとからダミーが付いた場合', () => {
  const assignmentsAt = async () =>
    new Map((await listAssignments(env.DB, { from: CHECKOUT, to: CHECKOUT })).map((r) => [r.bookingId, r]));

  it('★対象外になり、外注に回っていた清掃がスタッフに引き戻される', async () => {
    await setSetting(env.DB, 'exclude_title_words', 'ダミー');
    await openCapacity(1); // 枠は1件だけ

    // 1回目: どちらも普通のタイトル。1件がスタッフ、もう1件は外注になる
    await run(['予約A', '予約B']);
    const before = await assignmentsAt();
    expect(before.get('1').staffName).toBe('細田さん');
    expect(before.get('2').staffName).toBe('Rクリーン');

    // 2回目: 1件目のタイトルにダミーが足された
    await run(['予約A（ダミー）', '予約B']);
    const after = await assignmentsAt();

    expect(after.get('1').staffName).toBe('対象外');
    // ★空いた枠に、外注だった清掃が引き戻される
    expect(after.get('2').staffName).toBe('細田さん');
  });

  it('★外注が0件になる（費用が消えたことを数字で押さえる）', async () => {
    await setSetting(env.DB, 'exclude_title_words', 'ダミー');
    await openCapacity(1);

    await run(['予約A', '予約B']);
    const result = await run(['予約A（ダミー）', '予約B']);

    expect(result.stats.outsourced).toBe(0);
  });

  it('ダミーの語句を消せば、また割り当てに戻る', async () => {
    await setSetting(env.DB, 'exclude_title_words', 'ダミー');
    await openCapacity(2);

    await run(['予約A（ダミー）', '予約B']);
    expect((await assignmentsAt()).get('1').staffName).toBe('対象外');

    await setSetting(env.DB, 'exclude_title_words', '');
    await run(['予約A（ダミー）', '予約B']);

    expect((await assignmentsAt()).get('1').staffName).toBe('細田さん');
  });

  it('担当が変わったことは変更履歴に残る', async () => {
    await setSetting(env.DB, 'exclude_title_words', 'ダミー');
    await openCapacity(1);

    await run(['予約A', '予約B']);
    await run(['予約A（ダミー）', '予約B']);

    const history = await env.DB.prepare('SELECT * FROM assignment_history WHERE booking_id = ?')
      .bind('1')
      .all();
    expect(history.results.length).toBeGreaterThan(0);
  });

  it('★完了報告が済んだ清掃は、あとからダミーを付けても担当が消えない', async () => {
    await openCapacity(2);
    await run(['予約A', '予約B']);
    expect((await assignmentsAt()).get('1').staffName).toBe('細田さん');

    // 細田さんが実施して完了報告を出した
    await env.DB.prepare('UPDATE assignments SET completed_at = ? WHERE booking_id = ?')
      .bind('2026-09-12T02:00:00Z', '1')
      .run();

    // そのあとでタイトルにダミーが付いた
    await setSetting(env.DB, 'exclude_title_words', 'ダミー');
    await run(['予約A（ダミー）', '予約B']);

    const after = await assignmentsAt();
    expect(after.get('1').staffName).toBe('細田さん');
    expect(after.get('1').completedAt).toBeTruthy();
  });
});
