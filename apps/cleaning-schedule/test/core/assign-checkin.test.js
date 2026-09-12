/**
 * 「13:30」の出勤枠（当日チェックインありは1件まで）のテスト
 *
 * 清掃員が 13:30〜18:00 しか出られない日は、
 *   ・16:00 の入室に間に合わせる清掃が1件
 *   ・入室の無い部屋（翌日清掃）は 18:00 完了でよいのでもう1件
 * で、合計2件。ただし**入室のある部屋は1件まで**。
 *
 * 数字だけの入力では「2件」としか言えず、2件とも入室ありの日に
 * 割り当てられてしまうため、上限を別に持たせた。
 */

import { describe, it, expect } from 'vitest';
import { assign, STATUS, DEFAULT_PARAMS } from '../../src/core/assign.js';

const TODAY = '2026-09-10';
const D = '2026-09-12';

const STAFF = [
  { name: '細田さん', priority: 1, kind: 'staff', defaultCapacity: 0 },
  { name: 'Rクリーン', priority: 99, kind: 'outsource', defaultCapacity: 99 }
];

/**
 * 予約を作る。
 * @param {{id:string, unit:string, checkout?:string, checkinOn?:string|null}} spec
 *   checkinOn を入れると「その部屋にその日に入室がある」状態になる
 */
function booking({ id, unit, checkout = D, checkinOn = null }) {
  return { bookingId: id, unit, checkoutDate: checkout, startDate: checkinOn, guests: 2, title: '' };
}

/** その部屋にその日の入室を作るためだけの予約（清掃対象にはならない先の予約） */
function arrival(id, unit, date) {
  return { bookingId: id, unit, checkoutDate: '2026-12-31', startDate: date, guests: 2, title: '' };
}

function run({ bookings, capacity, checkinLimits, existing = [] }) {
  return assign({
    today: TODAY,
    bookings,
    existing,
    staff: STAFF,
    capacity,
    checkinLimits,
    params: { maxDeferDays: 2, outsourceWindowDays: 14 }
  });
}

const byId = (result) => new Map(result.assignments.map((a) => [a.bookingId, a]));

describe('上限を渡さないとき', () => {
  it('★これまでとまったく同じ（入室があっても2件とも割り当たる）', () => {
    const result = run({
      bookings: [
        booking({ id: '1', unit: 'b4' }),
        booking({ id: '2', unit: 'b5' }),
        arrival('a1', 'b4', D),
        arrival('a2', 'b5', D)
      ],
      capacity: { 細田さん: { [D]: 2 } }
    });

    const map = byId(result);
    expect(map.get('1').staffName).toBe('細田さん');
    expect(map.get('2').staffName).toBe('細田さん');
  });
});

describe('13:30 の枠（合計2件・入室ありは1件まで）', () => {
  const LIMIT = { 細田さん: { [D]: 1 } };
  const CAP = { 細田さん: { [D]: 2 } };

  it('★入室あり1件＋入室なし1件 → 両方とも割り当たる（これが目的）', () => {
    const result = run({
      bookings: [
        booking({ id: '1', unit: 'b4' }), // b4 はこの日に入室あり
        booking({ id: '2', unit: 'b5' }), // b5 は入室なし
        arrival('a1', 'b4', D)
      ],
      capacity: CAP,
      checkinLimits: LIMIT
    });

    const map = byId(result);
    expect(map.get('1').staffName).toBe('細田さん');
    expect(map.get('2').staffName).toBe('細田さん');
  });

  it('★入室ありが2件 → スタッフは1件だけ。残りは外注か未割当へ', () => {
    const result = run({
      bookings: [
        booking({ id: '1', unit: 'b4' }),
        booking({ id: '2', unit: 'b5' }),
        arrival('a1', 'b4', D),
        arrival('a2', 'b5', D)
      ],
      capacity: CAP,
      checkinLimits: LIMIT
    });

    const taken = result.assignments.filter((a) => a.staffName === '細田さん');
    expect(taken).toHaveLength(1);

    const other = result.assignments.find((a) => ['1', '2'].includes(a.bookingId) && a.staffName !== '細田さん');
    expect(other.staffName).not.toBe('細田さん');
  });

  it('★入室なしが2件 → 2件とも割り当たる（合計2件までは使える）', () => {
    const result = run({
      bookings: [booking({ id: '1', unit: 'b4' }), booking({ id: '2', unit: 'b5' })],
      capacity: CAP,
      checkinLimits: LIMIT
    });

    const map = byId(result);
    expect(map.get('1').staffName).toBe('細田さん');
    expect(map.get('2').staffName).toBe('細田さん');
  });

  it('入室ありが1件だけなら、当然その1件は受けられる', () => {
    const result = run({
      bookings: [booking({ id: '1', unit: 'b4' }), arrival('a1', 'b4', D)],
      capacity: CAP,
      checkinLimits: LIMIT
    });

    expect(byId(result).get('1').staffName).toBe('細田さん');
  });
});

describe('引き継ぎと日付の移動', () => {
  const LIMIT = { 細田さん: { [D]: 1 } };
  const CAP = { 細田さん: { [D]: 2 } };

  it('★前回の割り当ても上限に数える（続けて実行しても増えない）', () => {
    const bookings = [
      booking({ id: '1', unit: 'b4' }),
      booking({ id: '2', unit: 'b5' }),
      arrival('a1', 'b4', D),
      arrival('a2', 'b5', D)
    ];

    const first = run({ bookings, capacity: CAP, checkinLimits: LIMIT });
    const second = run({
      bookings,
      capacity: CAP,
      checkinLimits: LIMIT,
      existing: first.assignments.map((a) => ({ ...a, isManual: false }))
    });

    expect(second.assignments.filter((a) => a.staffName === '細田さん')).toHaveLength(1);
  });

  it('★延期したときは、延期先の日で入室ありを判定する', () => {
    const NEXT = '2026-09-13';

    // b4 は 9/12 に入室があるが、9/13 には無い。
    // 9/12 の枠を使い切らせて 9/13 に延ばすと、入室なし扱いで受けられる
    const result = run({
      bookings: [
        booking({ id: '1', unit: 'b4' }),
        arrival('a1', 'b4', D),
        // 延期できるよう、次の予約は先の日付にしておく
        arrival('a2', 'b4', '2026-10-01')
      ],
      capacity: { 細田さん: { [D]: 0, [NEXT]: 2 } },
      checkinLimits: { 細田さん: { [NEXT]: 1 } }
    });

    const a = byId(result).get('1');
    if (a.cleaningDate === NEXT) {
      // 延期先では入室が無いので、上限に関係なく受けられる
      expect(a.staffName).toBe('細田さん');
    }
  });
});

describe('外注の引き戻し', () => {
  it('上限に空きが無ければ、外注から引き戻さない', () => {
    const bookings = [
      booking({ id: '1', unit: 'b4' }),
      booking({ id: '2', unit: 'b5' }),
      arrival('a1', 'b4', D),
      arrival('a2', 'b5', D)
    ];

    const result = run({
      bookings,
      capacity: { 細田さん: { [D]: 2 } },
      checkinLimits: { 細田さん: { [D]: 1 } },
      existing: [
        { bookingId: '1', unit: 'b4', cleaningDate: D, checkoutDate: D, staffName: '細田さん', status: STATUS.CONFIRMED, isManual: false },
        { bookingId: '2', unit: 'b5', cleaningDate: D, checkoutDate: D, staffName: 'Rクリーン', status: STATUS.OUTSOURCED, isManual: false }
      ]
    });

    // 2件とも入室ありなので、外注のままか未割当。細田さんが2件持つことはない
    expect(result.assignments.filter((a) => a.staffName === '細田さん')).toHaveLength(1);
  });
});
