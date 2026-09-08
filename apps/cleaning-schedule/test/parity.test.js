/**
 * 新旧一致テスト（parity / characterization test）
 *
 * 旧 GAS 版のロジックをそのままコピーした legacy エンジンと、
 * 新実装 `src/core/assign.js` の出力が完全に一致することを検証する。
 *
 * 8版かけて実運用で調整されたアルゴリズムを移植するにあたり、
 * 「意図せず挙動が変わっていないか」を確かめる唯一の現実的な手段。
 * ランダム生成したシナリオを大量に流し、1件でも差分が出たら失敗させる。
 */

import { describe, it, expect } from 'vitest';
import { assign } from '../src/core/assign.js';
import { legacyDoMatching } from './legacy/legacy-engine.mjs';
import { addDays } from '../src/core/dates.js';

const UNITS = ['b2', 'b3', 'b4', 'b5', 'b6', 'c4', 's1', 's2', 's3'];
const STAFF_NAMES = ['細田さん', '普久原さん', '福田さん'];
const OUTSOURCE = 'Rクリーン';
const UNASSIGNED = '未割当';

const NEW_STAFF = [
  { name: '細田さん', priority: 1, kind: 'staff', defaultCapacity: 0 },
  { name: '普久原さん', priority: 2, kind: 'staff', defaultCapacity: 0 },
  { name: '福田さん', priority: 3, kind: 'staff', defaultCapacity: 0 },
  { name: OUTSOURCE, priority: 99, kind: 'outsource', defaultCapacity: 99 }
];

const LEGACY_CFG = {
  staff: [
    { name: '細田さん', calendarId: 'x', defaultCap: 0 },
    { name: '普久原さん', calendarId: 'x', defaultCap: 0 },
    { name: '福田さん', calendarId: 'x', defaultCap: 0 },
    { name: OUTSOURCE, calendarId: 'x', defaultCap: 99 }
  ]
};

// ------------------------------------------------------------------
// 乱数（シード固定。失敗したケースを再現できるようにする）
// ------------------------------------------------------------------
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
const pick = (rng, arr) => arr[randInt(rng, 0, arr.length - 1)];

// ------------------------------------------------------------------
// 形式変換: 共通シナリオ → 旧エンジンの入力
// ------------------------------------------------------------------
const toSlash = (ymd) => ymd.replace(/-/g, '/');
const toDate = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)));

function toLegacyInput(sc) {
  const reservations = [...sc.bookings]
    .sort((a, b) => toDate(a.checkoutDate) - toDate(b.checkoutDate))
    .map((b) => {
      const checkout = toDate(b.checkoutDate);
      return {
        bookingId: b.bookingId,
        title: b.title || '',
        startDate: b.startDate ? toDate(b.startDate) : null,
        startDateStr: b.startDate ? toSlash(b.startDate) : '',
        date: checkout,
        dateStr: toSlash(b.checkoutDate),
        unit: b.unit,
        dow: checkout.getDay(),
        guests: b.guests || 0
      };
    });

  const db = {};
  for (const e of sc.existing) {
    db[e.bookingId] = {
      bookingId: e.bookingId,
      checkoutDateStr: toSlash(e.checkoutDate),
      cleaningDateStr: toSlash(e.cleaningDate),
      unit: e.unit,
      title: e.title || '',
      staff: e.staffName,
      eventId: 'evt',
      syncStatus: '完了',
      lastSync: '',
      nextGuests: 0
    };
  }

  const caps = {};
  for (const [name, perDate] of Object.entries(sc.capacity)) {
    caps[name] = {};
    for (const [date, n] of Object.entries(perDate)) caps[name][toSlash(date)] = n;
  }

  return { cfg: LEGACY_CFG, reservations, db, caps, today: toDate(sc.today) };
}

// 比較しやすい形に正規化する
const normalizeLegacy = (rows) =>
  rows.map((a) => ({
    bookingId: a.bookingId,
    checkoutDate: a.checkoutDateStr.replace(/\//g, '-'),
    cleaningDate: a.dateStr.replace(/\//g, '-'),
    dayName: a.dayName,
    unit: a.unit,
    staffName: a.staff,
    status: a.status,
    guests: a.guests
  }));

const normalizeNew = (result) =>
  result.assignments.map((a) => ({
    bookingId: a.bookingId,
    checkoutDate: a.checkoutDate,
    cleaningDate: a.cleaningDate,
    dayName: a.dayName,
    unit: a.unit,
    staffName: a.staffName,
    status: a.status,
    guests: a.guests
  }));

// ------------------------------------------------------------------
// ランダムシナリオ生成
//   9ユニット × 約60日分の予約、スタッフの出勤可能件数、前回の割り当て状態
// ------------------------------------------------------------------
function randomScenario(rng) {
  const today = '2026-09-08';
  const horizonStart = addDays(today, -5);
  const horizonEnd = addDays(today, 60);

  const bookings = [];
  let seq = 0;

  for (const unit of UNITS) {
    let cursor = addDays(horizonStart, randInt(rng, 0, 3));
    while (cursor < horizonEnd) {
      const gap = randInt(rng, 0, 6);
      const nights = randInt(rng, 1, 5);
      const start = addDays(cursor, gap);
      const checkout = addDays(start, nights);
      if (checkout > horizonEnd) break;

      seq += 1;
      bookings.push({
        bookingId: String(10000000 + seq),
        title: rng() < 0.12 ? '消毒ポット' : '',
        startDate: rng() < 0.05 ? null : start,
        checkoutDate: checkout,
        unit,
        guests: randInt(rng, 1, 6)
      });
      cursor = checkout;
    }
  }

  // 前回の割り当て状態（一部の予約に付ける）
  const existing = [];
  for (const b of bookings) {
    if (rng() > 0.45) continue;

    const roll = rng();
    const staffName =
      roll < 0.55 ? pick(rng, STAFF_NAMES) : roll < 0.75 ? OUTSOURCE : UNASSIGNED;

    // 延期済み（+1/+2日）の状態も作る。期限切れの巻き戻し処理を通すため
    // あえて期限を無視した日付も混ぜる
    const defer = rng() < 0.3 ? randInt(rng, 1, 2) : 0;

    // 一部はチェックアウト日・ユニットを変えて「変更あり」に倒す
    const mutate = rng() < 0.1;

    existing.push({
      bookingId: b.bookingId,
      checkoutDate: mutate ? addDays(b.checkoutDate, -1) : b.checkoutDate,
      cleaningDate: addDays(mutate ? addDays(b.checkoutDate, -1) : b.checkoutDate, defer),
      unit: b.unit,
      title: b.title,
      staffName,
      isManual: false
    });
  }

  // DBにあるが今回の予約データから消えたもの（キャンセル相当）
  for (let i = 0; i < randInt(rng, 0, 3); i++) {
    existing.push({
      bookingId: String(99000000 + i),
      checkoutDate: addDays(today, randInt(rng, 0, 30)),
      cleaningDate: addDays(today, randInt(rng, 0, 30)),
      unit: pick(rng, UNITS),
      title: '',
      staffName: pick(rng, STAFF_NAMES),
      isManual: false
    });
  }

  // 出勤可能件数（3割の日は未入力＝既定値0が使われる）
  const capacity = {};
  for (const name of STAFF_NAMES) {
    capacity[name] = {};
    for (let d = addDays(horizonStart, -2); d <= addDays(horizonEnd, 3); d = addDays(d, 1)) {
      if (rng() < 0.3) continue;
      capacity[name][d] = randInt(rng, 0, 4);
    }
  }

  return { today, bookings, existing, capacity, staff: NEW_STAFF };
}

function runBoth(sc) {
  const legacy = normalizeLegacy(legacyDoMatching(toLegacyInput(sc)));
  const next = normalizeNew(
    assign({
      today: sc.today,
      bookings: sc.bookings,
      existing: sc.existing,
      staff: sc.staff,
      capacity: sc.capacity
    })
  );
  return { legacy, next };
}

// ------------------------------------------------------------------
describe('新旧一致（parity）', () => {
  it('ランダム2000シナリオで旧エンジンと完全一致する', () => {
    const rng = makeRng(20260908);
    let checkedRows = 0;

    for (let i = 0; i < 2000; i++) {
      const sc = randomScenario(rng);
      const { legacy, next } = runBoth(sc);

      if (JSON.stringify(legacy) !== JSON.stringify(next)) {
        // 差分が出たシナリオを特定できるようにインデックスを出す
        expect(next, `シナリオ #${i} で差分が出ました`).toEqual(legacy);
      }
      checkedRows += legacy.length;
    }

    // シナリオが空回りしていないことの確認
    expect(checkedRows).toBeGreaterThan(100000);
  });

  it('空データでも一致する', () => {
    const sc = { today: '2026-09-08', bookings: [], existing: [], capacity: {}, staff: NEW_STAFF };
    const { legacy, next } = runBoth(sc);
    expect(next).toEqual(legacy);
    expect(next).toEqual([]);
  });

  it('前回の割り当てがない初回実行でも一致する', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 200; i++) {
      const sc = randomScenario(rng);
      sc.existing = [];
      const { legacy, next } = runBoth(sc);
      expect(next, `シナリオ #${i}`).toEqual(legacy);
    }
  });

  it('出勤可能件数がまったく入力されていない場合も一致する（全件外注/未割当）', () => {
    const rng = makeRng(99);
    for (let i = 0; i < 100; i++) {
      const sc = randomScenario(rng);
      sc.capacity = {};
      const { legacy, next } = runBoth(sc);
      expect(next, `シナリオ #${i}`).toEqual(legacy);
    }
  });
});
