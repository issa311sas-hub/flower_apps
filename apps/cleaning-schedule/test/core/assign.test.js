/**
 * 業務ルール単位のテスト
 *
 * parity テストが「旧版と同じか」を見るのに対し、こちらは
 * 「decisions.md に書かれたルールが実際に守られているか」を1つずつ固定する。
 * 旧版から意図的に変えた点（手動固定・スタッフの一般化）もここで担保する。
 */

import { describe, it, expect } from 'vitest';
import { assign, STATUS } from '../../src/core/assign.js';
import { buildCleaningDeadlines } from '../../src/core/deadlines.js';

const STAFF = [
  { name: '細田さん', priority: 1, kind: 'staff', defaultCapacity: 0 },
  { name: '普久原さん', priority: 2, kind: 'staff', defaultCapacity: 0 },
  { name: '福田さん', priority: 3, kind: 'staff', defaultCapacity: 0 },
  { name: 'Rクリーン', priority: 99, kind: 'outsource', defaultCapacity: 99 }
];

const TODAY = '2026-09-08';

/** 指定日に指定件数の枠を持つ capacity を作る */
function caps(spec) {
  const out = {};
  for (const [name, perDate] of Object.entries(spec)) out[name] = perDate;
  return out;
}

function run(overrides) {
  return assign({
    today: TODAY,
    staff: STAFF,
    existing: [],
    capacity: {},
    ...overrides
  });
}

const byId = (result, id) => result.assignments.find((a) => a.bookingId === id);

function booking(id, unit, checkoutDate, extra = {}) {
  return {
    bookingId: id,
    title: '',
    startDate: extra.startDate ?? null,
    checkoutDate,
    unit,
    guests: extra.guests ?? 2,
    ...extra
  };
}

describe('清掃期限の計算', () => {
  it('次の予約がなければ チェックアウト+2日 まで延期できる', () => {
    const d = buildCleaningDeadlines([booking('1', 'b2', '2026-09-10')]);
    expect(d['1'].deadline).toBe('2026-09-12');
    expect(d['1'].canDefer).toBe(true);
  });

  // 旧 GAS 版はここが実装漏れで、次の予約がないと1日も延期できなかった。
  // 移植の忠実性を確認する parity テストのためだけに互換モードを残している。
  it('【旧版互換モード】次の予約がなければ延期できない', () => {
    const d = buildCleaningDeadlines([booking('1', 'b2', '2026-09-10')], {
      allowDeferWithoutNextBooking: false
    });
    expect(d['1'].deadline).toBe('2026-09-10');
    expect(d['1'].canDefer).toBe(false);
  });

  it('次の予約まで間が空いていれば チェックアウト+2日 が上限（害虫防止）', () => {
    const d = buildCleaningDeadlines([
      booking('1', 'b2', '2026-09-10'),
      booking('2', 'b2', '2026-09-20', { startDate: '2026-09-18' })
    ]);
    expect(d['1'].deadline).toBe('2026-09-12');
    expect(d['1'].canDefer).toBe(true);
  });

  it('次の予約が翌日なら当日中に清掃（延期不可）', () => {
    const d = buildCleaningDeadlines([
      booking('1', 'b2', '2026-09-10'),
      booking('2', 'b2', '2026-09-14', { startDate: '2026-09-11' })
    ]);
    expect(d['1'].deadline).toBe('2026-09-10');
    expect(d['1'].canDefer).toBe(false);
  });

  it('次の予約が2日後なら 翌日まで延期できる', () => {
    const d = buildCleaningDeadlines([
      booking('1', 'b2', '2026-09-10'),
      booking('2', 'b2', '2026-09-15', { startDate: '2026-09-12' })
    ]);
    expect(d['1'].deadline).toBe('2026-09-11');
  });

  it('次の予約が離れていても +2日 を超えない', () => {
    const d = buildCleaningDeadlines([
      booking('1', 'b2', '2026-09-10'),
      booking('2', 'b2', '2026-09-25', { startDate: '2026-09-20' })
    ]);
    expect(d['1'].deadline).toBe('2026-09-12');
  });
});

describe('Phase 1: 当日の割り当て', () => {
  it('優先順位どおり 細田 → 普久原 → 福田 → 未割当 の順で埋まる', () => {
    const r = run({
      bookings: [
        booking('1', 'b2', '2026-09-10'),
        booking('2', 'b3', '2026-09-10'),
        booking('3', 'b4', '2026-09-10'),
        booking('4', 'b5', '2026-09-10')
      ],
      capacity: caps({
        細田さん: { '2026-09-10': 2 },
        普久原さん: { '2026-09-10': 1 },
        福田さん: { '2026-09-10': 0 }
      }),
      // 外注に流れないよう、当日を外注期限の外に出す
      params: { outsourceWindowDays: 0 }
    });

    const staffOf = r.assignments.map((a) => a.staffName);
    expect(staffOf.filter((s) => s === '細田さん')).toHaveLength(2);
    expect(staffOf.filter((s) => s === '普久原さん')).toHaveLength(1);
    expect(staffOf.filter((s) => s === '未割当')).toHaveLength(1);
  });

  it('延期できない予約が先にスタッフ枠を取る', () => {
    const r = run({
      bookings: [
        // 延期できる（次の予約まで間がある）
        booking('deferrable', 'b2', '2026-09-10'),
        booking('deferrable-next', 'b2', '2026-09-22', { startDate: '2026-09-18' }),
        // 延期できない（翌日から次の予約）
        booking('locked', 'b3', '2026-09-10'),
        booking('next', 'b3', '2026-09-14', { startDate: '2026-09-11' })
      ],
      capacity: caps({ 細田さん: { '2026-09-10': 1, '2026-09-11': 1 } })
    });

    expect(byId(r, 'locked').staffName).toBe('細田さん');
    expect(byId(r, 'locked').cleaningDate).toBe('2026-09-10');
    // 延期できるほうは翌日に回る
    expect(byId(r, 'deferrable').cleaningDate).toBe('2026-09-11');
    expect(byId(r, 'deferrable').status).toBe(STATUS.DEFERRED);
  });
});

describe('Phase 2: 延期', () => {
  it('当日に枠がなければ翌日、それも無理なら翌々日に回す（早い日を優先）', () => {
    const r = run({
      bookings: [
        booking('1', 'b2', '2026-09-10'),
        // 次の予約まで間があるので +2日 まで延期できる
        booking('2', 'b2', '2026-09-22', { startDate: '2026-09-18' })
      ],
      capacity: caps({ 細田さん: { '2026-09-10': 0, '2026-09-11': 0, '2026-09-12': 1 } })
    });
    expect(byId(r, '1').cleaningDate).toBe('2026-09-12');
    expect(byId(r, '1').status).toBe(STATUS.DEFERRED);
  });

  it('清掃期限を超えてまでは延期しない', () => {
    const r = run({
      bookings: [
        booking('1', 'b2', '2026-09-10'),
        // 翌日から次の予約 → 当日しか清掃できない
        booking('2', 'b2', '2026-09-14', { startDate: '2026-09-11' })
      ],
      capacity: caps({ 細田さん: { '2026-09-11': 5, '2026-09-12': 5 } })
    });
    // 翌日に枠があっても回さない。当日不可なので外注に落ちる
    expect(byId(r, '1').cleaningDate).toBe('2026-09-10');
    expect(byId(r, '1').staffName).toBe('Rクリーン');
  });
});

describe('Phase 2.5: 外注回避スワップ', () => {
  it('延期できる予約を後ろにずらし、空いた枠に延期できない予約を入れる', () => {
    const r = run({
      bookings: [
        // 延期できる（次の予約まで間がある）
        booking('flexible', 'b2', '2026-09-10'),
        booking('flexible-next', 'b2', '2026-09-22', { startDate: '2026-09-18' }),
        // 延期できない（翌日から次の予約）
        booking('locked', 'b3', '2026-09-10'),
        booking('next', 'b3', '2026-09-14', { startDate: '2026-09-11' })
      ],
      // 当日1枠・翌日1枠。Phase 1 の並べ替えを打ち消すため福田だけに枠を置く
      capacity: caps({ 福田さん: { '2026-09-10': 1, '2026-09-11': 1 } })
    });

    // 9/10 の2件はどちらもスタッフが担当し、外注に落ちない
    expect(byId(r, 'locked').staffName).toBe('福田さん');
    expect(byId(r, 'locked').cleaningDate).toBe('2026-09-10');
    expect(byId(r, 'flexible').staffName).toBe('福田さん');
    expect(byId(r, 'flexible').cleaningDate).toBe('2026-09-11');
    expect(byId(r, 'flexible').status).toBe(STATUS.DEFERRED);
  });
});

describe('Phase 3: 外注（Rクリーン）の安全ネット', () => {
  it('13日先の未割当は外注に回す', () => {
    const r = run({ bookings: [booking('1', 'b2', '2026-09-21')] }); // today+13
    expect(byId(r, '1').staffName).toBe('Rクリーン');
    expect(byId(r, '1').status).toBe(STATUS.OUTSOURCED);
  });

  it('15日先の未割当は外注に回さない（まだスタッフ確定の余地がある）', () => {
    const r = run({ bookings: [booking('1', 'b2', '2026-09-23')] }); // today+15
    expect(byId(r, '1').staffName).toBe('未割当');
    expect(byId(r, '1').status).toBe(STATUS.NEEDS_REVIEW);
  });

  it('前回外注にした予約でも、14日以上先なら未割当に戻す', () => {
    const b = booking('1', 'b2', '2026-09-30');
    const r = run({
      bookings: [b],
      existing: [
        {
          bookingId: '1',
          checkoutDate: '2026-09-30',
          cleaningDate: '2026-09-30',
          unit: 'b2',
          title: '',
          staffName: 'Rクリーン'
        }
      ]
    });
    expect(byId(r, '1').staffName).toBe('未割当');
  });
});

describe('Phase 4: 外注のコスト最適化', () => {
  it('同じ日にゲスト数の少ないスタッフ担当があれば外注と入れ替える', () => {
    const r = run({
      bookings: [
        booking('many', 'b2', '2026-09-10', { guests: 6 }),
        booking('few', 'b3', '2026-09-10', { guests: 1 })
      ],
      capacity: caps({ 細田さん: { '2026-09-10': 1 } })
    });

    // 人数の少ない b3 が外注、人数の多い b2 をスタッフが担当する
    expect(byId(r, 'few').staffName).toBe('Rクリーン');
    expect(byId(r, 'many').staffName).toBe('細田さん');
  });
});

describe('前回の割り当ての引き継ぎ', () => {
  it('変更のない予約は前回の担当を保持し、枠も消費する', () => {
    const r = run({
      bookings: [booking('1', 'b2', '2026-09-10'), booking('2', 'b3', '2026-09-10')],
      existing: [
        {
          bookingId: '1',
          checkoutDate: '2026-09-10',
          cleaningDate: '2026-09-10',
          unit: 'b2',
          title: '',
          staffName: '普久原さん'
        }
      ],
      capacity: caps({ 細田さん: { '2026-09-10': 1 } })
    });

    expect(byId(r, '1').staffName).toBe('普久原さん'); // 保持される
    expect(byId(r, '2').staffName).toBe('細田さん');
  });

  it('タイトル（特殊要望）だけの変更では再割り当てしない', () => {
    const r = run({
      bookings: [booking('1', 'b2', '2026-09-10', { title: 'ベビーベッド' })],
      existing: [
        {
          bookingId: '1',
          checkoutDate: '2026-09-10',
          cleaningDate: '2026-09-10',
          unit: 'b2',
          title: '消毒ポット',
          staffName: '福田さん'
        }
      ]
    });
    expect(byId(r, '1').staffName).toBe('福田さん');
    expect(byId(r, '1').title).toBe('ベビーベッド'); // 表示は新しいものになる
  });

  it('チェックアウト日が変わったら再割り当てする', () => {
    const r = run({
      bookings: [booking('1', 'b2', '2026-09-11')],
      existing: [
        {
          bookingId: '1',
          checkoutDate: '2026-09-10',
          cleaningDate: '2026-09-10',
          unit: 'b2',
          title: '',
          staffName: '細田さん'
        }
      ],
      capacity: caps({ 普久原さん: { '2026-09-11': 1 } })
    });
    expect(byId(r, '1').cleaningDate).toBe('2026-09-11');
    expect(byId(r, '1').staffName).toBe('普久原さん');
  });

  it('新しい予約で清掃期限が縮んだら、延期していた予約を当日に巻き戻す', () => {
    const r = run({
      bookings: [
        booking('1', 'b2', '2026-09-10'),
        // 後から入った予約。9/11 から泊まるので 9/10 中に清掃が必要になる
        booking('2', 'b2', '2026-09-14', { startDate: '2026-09-11' })
      ],
      existing: [
        {
          bookingId: '1',
          checkoutDate: '2026-09-10',
          cleaningDate: '2026-09-12', // 翌々日に延期済みだった
          unit: 'b2',
          title: '',
          staffName: '細田さん'
        }
      ]
    });
    expect(byId(r, '1').cleaningDate).toBe('2026-09-10');
  });

  it('予約が消えたら（キャンセル）割り当てからも消える', () => {
    const r = run({
      bookings: [],
      existing: [
        {
          bookingId: 'gone',
          checkoutDate: '2026-09-10',
          cleaningDate: '2026-09-10',
          unit: 'b2',
          title: '',
          staffName: '細田さん'
        }
      ]
    });
    expect(r.assignments).toHaveLength(0);
    expect(r.stats.removed).toBe(1);
  });
});

describe('手動固定（旧版にない新機能）', () => {
  it('管理者が手動変更した割り当ては自動割り当てで動かない', () => {
    const r = run({
      bookings: [booking('1', 'b2', '2026-09-10'), booking('2', 'b3', '2026-09-10')],
      existing: [
        {
          bookingId: '1',
          checkoutDate: '2026-09-10',
          cleaningDate: '2026-09-10',
          unit: 'b2',
          title: '',
          staffName: '福田さん',
          status: STATUS.CONFIRMED,
          isManual: true
        }
      ],
      capacity: caps({ 細田さん: { '2026-09-10': 5 } })
    });

    // 細田さんに枠があっても、手動固定された行は福田さんのまま
    expect(byId(r, '1').staffName).toBe('福田さん');
    expect(byId(r, '1').isManual).toBe(true);
    expect(byId(r, '2').staffName).toBe('細田さん');
  });

  it('手動固定された行も枠を消費する', () => {
    const r = run({
      bookings: [booking('1', 'b2', '2026-09-10'), booking('2', 'b3', '2026-09-10')],
      existing: [
        {
          bookingId: '1',
          checkoutDate: '2026-09-10',
          cleaningDate: '2026-09-10',
          unit: 'b2',
          title: '',
          staffName: '細田さん',
          status: STATUS.CONFIRMED,
          isManual: true
        }
      ],
      capacity: caps({ 細田さん: { '2026-09-10': 1 } }),
      params: { outsourceWindowDays: 0 }
    });

    // 細田さんの1枠は手動固定分で埋まっているので、もう1件は未割当になる
    expect(byId(r, '2').staffName).toBe('未割当');
  });
});

describe('スタッフ構成の一般化（旧版はコード変更が必要だった）', () => {
  it('スタッフを追加してもコード変更なしで割り当てられる', () => {
    const staff = [
      ...STAFF.filter((s) => s.kind === 'staff'),
      { name: '新人さん', priority: 4, kind: 'staff', defaultCapacity: 0 },
      STAFF.find((s) => s.kind === 'outsource')
    ];
    const r = assign({
      today: TODAY,
      staff,
      existing: [],
      bookings: [
        booking('1', 'b2', '2026-09-10'),
        booking('2', 'b3', '2026-09-10'),
        booking('3', 'b4', '2026-09-10'),
        booking('4', 'b5', '2026-09-10')
      ],
      capacity: caps({
        細田さん: { '2026-09-10': 1 },
        普久原さん: { '2026-09-10': 1 },
        福田さん: { '2026-09-10': 1 },
        新人さん: { '2026-09-10': 1 }
      })
    });

    expect(r.assignments.map((a) => a.staffName).sort()).toEqual(
      ['細田さん', '普久原さん', '福田さん', '新人さん'].sort()
    );
  });

  it('スタッフが1人も登録されていなければ警告を出す', () => {
    const r = assign({
      today: TODAY,
      staff: [STAFF.find((s) => s.kind === 'outsource')],
      bookings: [booking('1', 'b2', '2026-09-10')],
      existing: [],
      capacity: {}
    });
    expect(r.warnings.join()).toContain('稼働スタッフ');
  });
});

describe('外注の引き戻し（Phase 1.4）', () => {
  // 実運用で踏んだ問題。出勤入力が空のまま初回実行した結果、今後14日分が
  // まるごと外注に落ち、あとから出勤可能件数を入れても外注のままだった。
  const staff = [
    { name: '細田さん', priority: 1, kind: 'staff', defaultCapacity: 0 },
    { name: 'Rクリーン', priority: 99, kind: 'outsource', defaultCapacity: 99 }
  ];
  const bookings = [{ bookingId: '1', checkoutDate: '2026-09-10', unit: 'b4', guests: 2, title: '' }];

  const outsourced = (extra = {}) => [
    {
      bookingId: '1',
      checkoutDate: '2026-09-10',
      cleaningDate: '2026-09-10',
      unit: 'b4',
      staffName: 'Rクリーン',
      status: '外注',
      isManual: false,
      ...extra
    }
  ];

  const run = (existing, capacity, params) =>
    assign({ today: '2026-09-09', bookings, existing, staff, capacity, params }).assignments[0];

  const withRoom = { '細田さん': { '2026-09-10': 3 } };

  it('あとから出勤可能件数を入れれば、外注からスタッフに戻る', () => {
    const result = run(outsourced(), withRoom);
    expect(result.staffName).toBe('細田さん');
    expect(result.status).toBe('確定');
  });

  it('空き枠が無ければ外注のまま', () => {
    expect(run(outsourced(), {}).staffName).toBe('Rクリーン');
    expect(run(outsourced(), { '細田さん': { '2026-09-10': 0 } }).staffName).toBe('Rクリーン');
  });

  it('手動で固定した行は動かさない', () => {
    expect(run(outsourced({ isManual: true }), withRoom).staffName).toBe('Rクリーン');
  });

  it('完了報告が済んだ行は動かさない', () => {
    expect(run(outsourced({ completedAt: '2026-09-10T02:00:00Z' }), withRoom).staffName).toBe('Rクリーン');
  });

  it('過去の清掃日は書き換えない', () => {
    const past = [{ bookingId: '1', checkoutDate: '2026-09-05', unit: 'b4', guests: 2, title: '' }];
    const existing = [
      {
        bookingId: '1',
        checkoutDate: '2026-09-05',
        cleaningDate: '2026-09-05',
        unit: 'b4',
        staffName: 'Rクリーン',
        status: '外注',
        isManual: false
      }
    ];

    const result = assign({
      today: '2026-09-09',
      bookings: past,
      existing,
      staff,
      capacity: { '細田さん': { '2026-09-05': 3 } }
    }).assignments[0];

    expect(result.staffName).toBe('Rクリーン');
  });

  it('旧版互換モードでは引き戻さない（新旧一致テストが守られる）', () => {
    expect(run(outsourced(), withRoom, { reclaimOutsourced: false }).staffName).toBe('Rクリーン');
  });

  it('空き枠より外注が多ければ、埋まる分だけ戻る', () => {
    const two = [
      { bookingId: '1', checkoutDate: '2026-09-10', unit: 'b4', guests: 2, title: '' },
      { bookingId: '2', checkoutDate: '2026-09-10', unit: 'b5', guests: 2, title: '' }
    ];
    const existing = two.map((b) => ({
      bookingId: b.bookingId,
      checkoutDate: b.checkoutDate,
      cleaningDate: b.checkoutDate,
      unit: b.unit,
      staffName: 'Rクリーン',
      status: '外注',
      isManual: false
    }));

    const result = assign({
      today: '2026-09-09',
      bookings: two,
      existing,
      staff,
      capacity: { '細田さん': { '2026-09-10': 1 } }
    });

    const names = result.assignments.map((a) => a.staffName).sort();
    expect(names).toEqual(['Rクリーン', '細田さん']);
  });
});
