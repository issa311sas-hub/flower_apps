/**
 * データ層のテスト
 *
 * `node:sqlite` の上に D1 互換のアダプタをかぶせ、
 * 実際のマイグレーション（migrations/*.sql）と実際の SQL に対して検証する。
 * Cloudflare も追加パッケージも不要で動く。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../support/d1-sqlite.js';

import { getSettings, getSetting, setSetting, setSettings, getAssignParams } from '../../src/db/settings.js';
import { listStaff, listAvailabilityStaff, toAssignStaff, getStaffByName, createStaff, updateStaff } from '../../src/db/staff.js';
import { listUnitNames, getUnitLookup, replaceUnitMap, listUnitMap } from '../../src/db/units.js';
import { applyFetchedBookings, listActiveBookings, getBooking } from '../../src/db/bookings.js';
import { getCapacityMap, setCapacity, setCapacityBulk, listForStaff, countMissingDays } from '../../src/db/availability.js';
import { saveAssignments, loadExisting, listAssignments, setManual, clearManual, markCompleted, listHistory } from '../../src/db/assignments.js';
import { startRun, finishRun, getRunHealth, listRuns } from '../../src/db/runs.js';
import { recordNotification, listUnacknowledged, acknowledge } from '../../src/db/notifications.js';

let db;
beforeEach(() => {
  db = createTestDb();
});

describe('マイグレーションと初期データ', () => {
  it('9ユニットがタイムラインの並び順で入っている', async () => {
    expect(await listUnitNames(db)).toEqual(['b4', 'b5', 'b6', 'b2', 'b3', 's1', 's2', 's3', 'c4']);
  });

  it('スタッフ3名＋Rクリーンが優先順位順に入っている', async () => {
    const staff = await listStaff(db);
    expect(staff.map((s) => s.name)).toEqual(['細田さん', '普久原さん', '福田さん', 'Rクリーン']);
    expect(staff.map((s) => s.kind)).toEqual(['staff', 'staff', 'staff', 'outsource']);
  });

  it('スタッフの既定上限は0（未入力＝出勤不可のフェイルセーフ）', async () => {
    const hosoda = await getStaffByName(db, '細田さん');
    expect(hosoda.defaultCapacity).toBe(0);
  });

  it('Rクリーンは出勤入力の対象外', async () => {
    const names = (await listAvailabilityStaff(db)).map((s) => s.name);
    expect(names).toEqual(['細田さん', '普久原さん', '福田さん']);
  });

  it('割り当てエンジンに渡す形に変換できる', async () => {
    const staff = toAssignStaff(await listStaff(db));
    expect(staff[0]).toEqual({ name: '細田さん', priority: 1, kind: 'staff', defaultCapacity: 0 });
  });
});

describe('設定', () => {
  it('既定値が入っている', async () => {
    const s = await getSettings(db);
    expect(s.fetch_days).toBe(90);
    expect(s.outsource_window_days).toBe(14);
    expect(s.max_defer_days).toBe(2);
  });

  it('数値の設定は数値として返る', async () => {
    expect(await getSetting(db, 'fetch_days')).toBe(90);
    expect(typeof await getSetting(db, 'notify_webhook_url')).toBe('string');
  });

  it('更新できる', async () => {
    await setSetting(db, 'outsource_window_days', 21);
    expect(await getSetting(db, 'outsource_window_days')).toBe(21);
  });

  it('まとめて更新できる', async () => {
    await setSettings(db, { fetch_days: 60, notify_webhook_url: 'https://hooks.slack.com/x' });
    const s = await getSettings(db);
    expect(s.fetch_days).toBe(60);
    expect(s.notify_webhook_url).toBe('https://hooks.slack.com/x');
  });

  it('割り当てエンジンのパラメータを組み立てられる', async () => {
    expect(await getAssignParams(db)).toEqual({ maxDeferDays: 2, outsourceWindowDays: 14 });
  });
});

describe('スタッフ管理', () => {
  it('追加できる（旧版はコード変更が必要だった）', async () => {
    await createStaff(db, { name: '新人さん', shortName: '新', priority: 4 });
    const names = (await listStaff(db)).map((s) => s.name);
    expect(names).toContain('新人さん');
    expect(names.indexOf('新人さん')).toBe(3); // 優先順位順
  });

  it('無効にすると一覧から外れる', async () => {
    const fukuda = await getStaffByName(db, '福田さん');
    await updateStaff(db, fukuda.id, { isActive: false });
    expect((await listStaff(db)).map((s) => s.name)).not.toContain('福田さん');
    expect((await listStaff(db, { includeInactive: true })).map((s) => s.name)).toContain('福田さん');
  });
});

describe('ユニットマッピング', () => {
  it('roomId:unitId の組で引ける', async () => {
    await replaceUnitMap(db, [
      { roomId: '123', unitId: '1', unitName: 'b4' },
      { roomId: '123', unitId: '2', unitName: 'b5' }
    ]);
    const lookup = await getUnitLookup(db);
    expect(lookup.get('123:1')).toBe('b4');
    expect(lookup.get('123:2')).toBe('b5');
  });

  it('保存し直すと入れ替わる', async () => {
    await replaceUnitMap(db, [{ roomId: '1', unitId: '', unitName: 'b2' }]);
    await replaceUnitMap(db, [{ roomId: '2', unitId: '', unitName: 'b3' }]);
    const rows = await listUnitMap(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].roomId).toBe('2');
  });

  it('存在しないユニット名は外部キーで弾かれる', async () => {
    await expect(replaceUnitMap(db, [{ roomId: '1', unitId: '', unitName: 'zz' }])).rejects.toThrow();
  });
});

describe('予約データ', () => {
  const range = { from: '2026-09-01', to: '2026-12-01' };
  const b = (id, unit, checkout, extra = {}) => ({
    bookingId: id,
    title: '',
    startDate: '2026-09-05',
    checkoutDate: checkout,
    unit,
    guests: 2,
    ...extra
  });

  it('取得結果を保存して読み戻せる', async () => {
    await applyFetchedBookings(db, [b('1', 'b2', '2026-09-10'), b('2', 'b3', '2026-09-11')], range, '2026-09-08T21:00:00Z');
    const rows = await listActiveBookings(db);
    expect(rows.map((r) => r.bookingId)).toEqual(['1', '2']);
    expect(rows[0].unit).toBe('b2');
  });

  it('2回目の取得で内容が更新される', async () => {
    await applyFetchedBookings(db, [b('1', 'b2', '2026-09-10')], range, '2026-09-08T21:00:00Z');
    await applyFetchedBookings(db, [b('1', 'b2', '2026-09-12', { guests: 5 })], range, '2026-09-09T21:00:00Z');
    const row = await getBooking(db, '1');
    expect(row.checkoutDate).toBe('2026-09-12');
    expect(row.guests).toBe(5);
  });

  it('取得結果から消えた予約はキャンセル扱いになる（削除はしない）', async () => {
    await applyFetchedBookings(db, [b('1', 'b2', '2026-09-10'), b('2', 'b3', '2026-09-11')], range, '2026-09-08T21:00:00Z');
    const result = await applyFetchedBookings(db, [b('1', 'b2', '2026-09-10')], range, '2026-09-09T21:00:00Z');

    expect(result.cancelled).toBe(1);
    expect((await listActiveBookings(db)).map((r) => r.bookingId)).toEqual(['1']);
    expect((await getBooking(db, '2')).state).toBe('cancelled');
  });

  it('取得期間外の予約はキャンセル扱いにしない', async () => {
    await applyFetchedBookings(db, [b('old', 'b2', '2026-08-01')], { from: '2026-07-01', to: '2026-08-31' }, '2026-09-08T21:00:00Z');
    await applyFetchedBookings(db, [], range, '2026-09-09T21:00:00Z');
    expect((await getBooking(db, 'old')).state).toBe('active');
  });
});

describe('出勤可能件数', () => {
  it('保存して割り当てエンジンの形で読める', async () => {
    const hosoda = await getStaffByName(db, '細田さん');
    await setCapacity(db, hosoda.id, '2026-09-10', 3);

    const map = await getCapacityMap(db, { from: '2026-09-01', to: '2026-09-30' });
    expect(map['細田さん']['2026-09-10']).toBe(3);
  });

  it('月まとめて保存できる', async () => {
    const hosoda = await getStaffByName(db, '細田さん');
    const saved = await setCapacityBulk(db, hosoda.id, [
      { date: '2026-09-10', capacity: 3 },
      { date: '2026-09-11', capacity: 0 },
      { date: '2026-09-12', capacity: 2 }
    ]);
    expect(saved).toBe(3);
    expect(await listForStaff(db, hosoda.id, { from: '2026-09-01', to: '2026-09-30' })).toEqual({
      '2026-09-10': { capacity: 3, checkinLimit: null },
      '2026-09-11': { capacity: 0, checkinLimit: null },
      '2026-09-12': { capacity: 2, checkinLimit: null }
    });
  });

  it('同じ日を保存し直すと上書きされる', async () => {
    const hosoda = await getStaffByName(db, '細田さん');
    await setCapacity(db, hosoda.id, '2026-09-10', 3);
    await setCapacity(db, hosoda.id, '2026-09-10', 1);
    const map = await getCapacityMap(db, { from: '2026-09-10', to: '2026-09-10' });
    expect(map['細田さん']['2026-09-10']).toBe(1);
  });

  it('0〜9の範囲外は保存できない', async () => {
    const hosoda = await getStaffByName(db, '細田さん');
    await expect(setCapacity(db, hosoda.id, '2026-09-10', 12)).rejects.toThrow();
  });

  it('入力済みの日数を数えられる（入力漏れの可視化用）', async () => {
    const hosoda = await getStaffByName(db, '細田さん');
    await setCapacityBulk(db, hosoda.id, [
      { date: '2026-09-10', capacity: 3 },
      { date: '2026-09-11', capacity: 3 }
    ]);
    const counts = await countMissingDays(db, { from: '2026-09-01', to: '2026-09-30' });
    expect(counts.find((c) => c.name === '細田さん').filled).toBe(2);
    expect(counts.find((c) => c.name === '普久原さん').filled).toBe(0);
    expect(counts.map((c) => c.name)).not.toContain('Rクリーン');
  });
});

describe('割り当ての保存', () => {
  const range = { from: '2026-09-01', to: '2026-12-01' };

  async function seedBookings() {
    await applyFetchedBookings(
      db,
      [
        { bookingId: '1', title: '', startDate: '2026-09-05', checkoutDate: '2026-09-10', unit: 'b2', guests: 2 },
        { bookingId: '2', title: '', startDate: '2026-09-06', checkoutDate: '2026-09-10', unit: 'b3', guests: 4 }
      ],
      range,
      '2026-09-08T21:00:00Z'
    );
  }

  const assignment = (id, unit, staffName, overrides = {}) => ({
    bookingId: id,
    checkoutDate: '2026-09-10',
    cleaningDate: '2026-09-10',
    unit,
    title: '',
    staffName,
    status: '確定',
    guests: 2,
    isManual: false,
    ...overrides
  });

  it('保存して読み戻せる', async () => {
    await seedBookings();
    await saveAssignments(db, [assignment('1', 'b2', '細田さん'), assignment('2', 'b3', '普久原さん')], {
      nextGuests: { 1: 3, 2: 0 }
    });

    const rows = await listAssignments(db);
    expect(rows).toHaveLength(2);
    expect(rows[0].staffName).toBe('細田さん');
    expect(rows[0].nextGuests).toBe(3);
  });

  it('結果に含まれない予約は削除される', async () => {
    await seedBookings();
    await saveAssignments(db, [assignment('1', 'b2', '細田さん'), assignment('2', 'b3', '普久原さん')]);
    await saveAssignments(db, [assignment('1', 'b2', '細田さん')]);

    expect((await listAssignments(db)).map((a) => a.bookingId)).toEqual(['1']);
  });

  it('担当が変わったら履歴に残る', async () => {
    await seedBookings();
    await saveAssignments(db, [assignment('1', 'b2', '細田さん')]);
    await saveAssignments(db, [assignment('1', 'b2', '福田さん')]);

    const history = await listHistory(db, '1');
    expect(history).toHaveLength(1);
    expect(history[0].old_staff).toBe('細田さん');
    expect(history[0].new_staff).toBe('福田さん');
  });

  it('手動固定すると is_manual が立ち、履歴も残る', async () => {
    await seedBookings();
    await saveAssignments(db, [assignment('1', 'b2', '細田さん')]);

    const updated = await setManual(db, '1', { staffName: '福田さん', cleaningDate: '2026-09-11', status: '確定（翌日）' }, { changedBy: 'admin:owner' });
    expect(updated.isManual).toBe(true);
    expect(updated.staffName).toBe('福田さん');
    expect(updated.cleaningDate).toBe('2026-09-11');

    const history = await listHistory(db, '1');
    expect(history[0].changed_by).toBe('admin:owner');
  });

  it('手動固定は次回保存時も維持される', async () => {
    await seedBookings();
    await saveAssignments(db, [assignment('1', 'b2', '細田さん')]);
    await setManual(db, '1', { staffName: '福田さん' });

    // 割り当てエンジンは手動固定の行をそのまま返してくる想定
    const existing = await loadExisting(db);
    expect(existing.find((a) => a.bookingId === '1').isManual).toBe(true);

    await saveAssignments(db, [assignment('1', 'b2', '福田さん', { isManual: true })]);
    expect((await listAssignments(db))[0].isManual).toBe(true);
  });

  it('手動固定を解除できる', async () => {
    await seedBookings();
    await saveAssignments(db, [assignment('1', 'b2', '細田さん')]);
    await setManual(db, '1', { staffName: '福田さん' });
    await clearManual(db, '1');
    expect((await listAssignments(db))[0].isManual).toBe(false);
  });

  it('完了報告を記録できる', async () => {
    await seedBookings();
    await saveAssignments(db, [assignment('1', 'b2', '細田さん')]);
    await markCompleted(db, '1', { at: '2026-09-10T02:00:00Z' });
    expect((await listAssignments(db))[0].completedAt).toBe('2026-09-10T02:00:00Z');
  });

  it('担当と期間で絞り込める', async () => {
    await seedBookings();
    await saveAssignments(db, [
      assignment('1', 'b2', '細田さん'),
      assignment('2', 'b3', '普久原さん', { cleaningDate: '2026-09-12' })
    ]);

    expect((await listAssignments(db, { staffName: '細田さん' })).map((a) => a.bookingId)).toEqual(['1']);
    expect((await listAssignments(db, { from: '2026-09-11' })).map((a) => a.bookingId)).toEqual(['2']);
  });

  it('予約が消えると割り当ても消える（外部キー）', async () => {
    await seedBookings();
    await saveAssignments(db, [assignment('1', 'b2', '細田さん')]);
    await db.prepare('DELETE FROM bookings WHERE booking_id = ?').bind('1').run();
    expect(await listAssignments(db)).toHaveLength(0);
  });
});

describe('実行ログと稼働監視', () => {
  it('開始と終了を記録できる', async () => {
    const runId = await startRun(db, 'cron', { at: '2026-09-08T21:00:00Z' });
    await finishRun(db, runId, {
      ok: true,
      stats: { fetched: 100, total: 90, confirmed: 80, deferred: 5, outsourced: 3, unassigned: 2 },
      at: '2026-09-08T21:00:10Z'
    });

    const runs = await listRuns(db);
    expect(runs[0].ok).toBe(1);
    expect(runs[0].outsourced).toBe(3);
  });

  it('成功すると最終成功時刻が進む', async () => {
    const runId = await startRun(db, 'cron', { at: '2026-09-08T21:00:00Z' });
    await finishRun(db, runId, { ok: true, at: '2026-09-08T21:00:10Z' });

    expect((await getRunHealth(db)).lastSuccessAt).toBe('2026-09-08T21:00:10Z');
  });

  it('失敗した実行は成功として数えない', async () => {
    const first = await startRun(db, 'cron');
    await finishRun(db, first, { ok: true, at: '2026-09-08T21:00:10Z' });
    const second = await startRun(db, 'cron');
    await finishRun(db, second, { ok: false, error: 'boom', at: '2026-09-09T21:00:10Z' });

    expect((await getRunHealth(db)).lastSuccessAt).toBe('2026-09-08T21:00:10Z');
  });

  it('手動実行の成功も数える（管理者が手で回せば予定は最新）', async () => {
    const runId = await startRun(db, 'manual');
    await finishRun(db, runId, { ok: true, at: '2026-09-08T21:00:10Z' });

    expect((await getRunHealth(db)).lastSuccessAt).toBe('2026-09-08T21:00:10Z');
  });

  it('★見張り役の成功は数えない（滞留の判定時計をリセットさせない）', async () => {
    // 見張り役は監視するだけで予約を取り直さず、しかも必ず正常終了する。
    // これを数えると「毎日成功している」ことになり、滞留の警告が永久に出なくなる。
    const daily = await startRun(db, 'cron');
    await finishRun(db, daily, { ok: true, at: '2026-09-01T21:00:00Z' });

    // そのあと見張り役だけが4日間動き続ける
    for (const day of ['02', '03', '04', '05']) {
      const id = await startRun(db, 'keepalive');
      await finishRun(db, id, { ok: true, at: `2026-09-${day}T09:00:00Z` });
    }

    const health = await getRunHealth(db, Date.parse('2026-09-05T21:00:00Z'));

    expect(health.lastSuccessAt).toBe('2026-09-01T21:00:00Z');
    expect(health.staleDays).toBe(4);
    expect(health.isStale).toBe(true);
  });

  it('一度も動いていない状態は「止まった」と区別する', async () => {
    const health = await getRunHealth(db);

    expect(health.neverRun).toBe(true);
    expect(health.isStale).toBe(false);
    expect(health.lastSuccessAt).toBeNull();
  });

  it('滞留を検知できる（旧版が静かに止まった件の再発防止）', async () => {
    const runId = await startRun(db, 'cron');
    await finishRun(db, runId, { ok: true, at: '2026-09-01T21:00:00Z' });

    const health = await getRunHealth(db, Date.parse('2026-09-05T21:00:00Z'));
    expect(health.staleDays).toBe(4);
    expect(health.isStale).toBe(true);
  });

  it('直近に成功していれば滞留ではない', async () => {
    const runId = await startRun(db, 'cron');
    await finishRun(db, runId, { ok: true, at: '2026-09-08T21:00:00Z' });

    const health = await getRunHealth(db, Date.parse('2026-09-09T21:00:00Z'));
    expect(health.isStale).toBe(false);
  });
});

describe('通知', () => {
  it('記録できる', async () => {
    const result = await recordNotification(db, {
      kind: 'run_error',
      level: 'error',
      subject: '自動実行が失敗しました',
      body: 'details'
    });
    expect(result.recorded).toBe(true);
    expect(await listUnacknowledged(db)).toHaveLength(1);
  });

  it('同じ種類は12時間に1回まで', async () => {
    await recordNotification(db, { kind: 'run_error', level: 'error', subject: 'a', body: 'b' }, { at: '2026-09-08T00:00:00Z' });
    const second = await recordNotification(db, { kind: 'run_error', level: 'error', subject: 'a', body: 'b' }, { at: '2026-09-08T06:00:00Z' });
    expect(second.recorded).toBe(false);

    const later = await recordNotification(db, { kind: 'run_error', level: 'error', subject: 'a', body: 'b' }, { at: '2026-09-08T13:00:00Z' });
    expect(later.recorded).toBe(true);
  });

  it('種類が違えばスロットルされない', async () => {
    await recordNotification(db, { kind: 'run_error', level: 'error', subject: 'a', body: 'b' }, { at: '2026-09-08T00:00:00Z' });
    const other = await recordNotification(db, { kind: 'auth_expired', level: 'error', subject: 'c', body: 'd' }, { at: '2026-09-08T00:01:00Z' });
    expect(other.recorded).toBe(true);
  });

  it('確認済みにするとバナーから消える', async () => {
    const { id } = await recordNotification(db, { kind: 'unassigned', level: 'warn', subject: 'a', body: 'b' });
    await acknowledge(db, id);
    expect(await listUnacknowledged(db)).toHaveLength(0);
  });
});
