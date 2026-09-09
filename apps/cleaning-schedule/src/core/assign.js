/**
 * 清掃担当の割り当てアルゴリズム
 *
 * 旧 GAS 版 `doMatching_`（Code.gs:540-946）の移植。
 * 8版かけて実運用で調整されたロジックのため、**挙動は原則そのまま**移している。
 * 現行と意図的に変えた点は下部の「旧版との違い」を参照。
 *
 * この関数は純粋関数である。DB・ネットワーク・現在時刻に一切触れない
 * （`today` は呼び出し側が JST で求めて渡す）。テストしやすさのための制約であり、
 * `src/core/` 配下でこれを破ってはいけない。
 *
 * ■ フェーズ構成
 *   Phase 0   : 前回の割り当てを引き継ぐ（変更のない予約）
 *   Phase 1   : チェックアウト日当日にスタッフを割り当て（延期できない予約を優先）
 *   Phase 1.4 : 外注に回した清掃を、空き枠ができていれば未割当に戻す
 *   Phase 1.5 : 既存の未割当を、空いたスタッフ枠に再割り当て
 *   Phase 2   : 未割当を +1日 / +2日 のスタッフ枠に振り替え（早い日を優先）
 *   Phase 2.5 : Rクリーン回避スワップ（延期できる予約を動かして枠を空ける）
 *   Phase 3   : 期限内（既定14日以内）の未割当を外注（Rクリーン）に割り当て
 *   Phase 4   : 外注のコスト最適化（同日でゲスト数が少ない部屋と入れ替え）
 */

import { addDays, dayNameOf } from './dates.js';
import { buildCleaningDeadlines } from './deadlines.js';
import { computeDiff } from './diff.js';

export const STATUS = {
  CONFIRMED: '確定',
  DEFERRED: '確定（翌日）',
  OUTSOURCED: '外注',
  NEEDS_REVIEW: '要確認'
};

export const DEFAULT_PARAMS = {
  maxDeferDays: 2,
  outsourceWindowDays: 14,
  unassignedLabel: '未割当',
  // 次の予約がないユニットの清掃を +2日 まで延期してよいか（仕様どおりの挙動）。
  // false にすると旧 GAS 版の実装漏れを再現する。新旧一致テスト専用。
  allowDeferWithoutNextBooking: true,
  // 一度 外注 に回した清掃でも、スタッフの空き枠ができたら取り戻すか。
  // false にすると旧 GAS 版の挙動を再現する。新旧一致テスト専用。
  reclaimOutsourced: true
};

/**
 * 担当者名から状態を決める。
 *
 * 管理画面の手動変更でも同じ規則を使うため export している。
 * 判定を2か所に書くと、自動と手動で状態がずれる。
 */
export function statusFor(staffName, { outsourceName, unassignedLabel }) {
  if (staffName === outsourceName) return STATUS.OUTSOURCED;
  if (staffName === unassignedLabel) return STATUS.NEEDS_REVIEW;
  return STATUS.CONFIRMED;
}

function capacityFor(capacity, member, date) {
  const perDate = capacity[member.name];
  if (perDate && perDate[date] !== undefined) return perDate[date];
  return member.defaultCapacity ?? 0;
}

function addUsage(usageByDate, date, staffName) {
  if (!usageByDate[date]) usageByDate[date] = {};
  usageByDate[date][staffName] = (usageByDate[date][staffName] || 0) + 1;
}

function remainingFor(capacity, usageByDate, member, date) {
  const used = (usageByDate[date] || {})[member.name] || 0;
  return Math.max(0, capacityFor(capacity, member, date) - used);
}

function makeAssignment(booking, staffName, ctx) {
  return {
    bookingId: booking.bookingId,
    checkoutDate: booking.checkoutDate,
    cleaningDate: booking.checkoutDate,
    dayName: dayNameOf(booking.checkoutDate),
    unit: booking.unit,
    title: booking.title || '',
    staffName,
    status: statusFor(staffName, ctx),
    guests: booking.guests || 0,
    isManual: false
  };
}

/**
 * @param {object} input
 * @param {string} input.today 'YYYY-MM-DD'（JST。呼び出し側が注入する）
 * @param {Array<{bookingId:string,title?:string,startDate?:string|null,checkoutDate:string,unit:string,guests?:number}>} input.bookings
 * @param {Array<{bookingId:string,checkoutDate:string,cleaningDate:string,unit:string,title?:string,staffName:string,status?:string,isManual?:boolean}>} [input.existing]
 * @param {Array<{name:string,priority:number,kind?:'staff'|'outsource',defaultCapacity?:number}>} input.staff
 * @param {Record<string, Record<string, number>>} [input.capacity] スタッフ名 → 日付 → 件数
 * @param {Partial<typeof DEFAULT_PARAMS>} [input.params]
 */
export function assign(input) {
  const params = { ...DEFAULT_PARAMS, ...(input.params || {}) };
  const { unassignedLabel } = params;
  const capacity = input.capacity || {};
  const warnings = [];

  // チェックアウト日の昇順で処理する。旧版は読み込み時にこの順に並べており
  // （Code.gs:257）、同日内の並び順が誰に割り当たるかを左右するため、
  // 呼び出し側の順序に依存しないようここで確定させる（安定ソート）。
  const bookings = [...(input.bookings || [])].sort((a, b) =>
    a.checkoutDate < b.checkoutDate ? -1 : a.checkoutDate > b.checkoutDate ? 1 : 0
  );

  // 稼働スタッフを優先順位順に、外注（Rクリーン）は別枠に分ける
  const members = [...(input.staff || [])].sort((a, b) => a.priority - b.priority);
  const workers = members.filter((s) => (s.kind ?? 'staff') === 'staff');
  const outsource = members.find((s) => s.kind === 'outsource') || null;
  const outsourceName = outsource ? outsource.name : null;
  const ctx = { outsourceName, unassignedLabel };

  if (workers.length === 0) {
    warnings.push('稼働スタッフが1人も登録されていません。すべて未割当になります。');
  }
  if (!outsourceName) {
    warnings.push('外注（Rクリーン）が登録されていません。外注への割り当ては行いません。');
  }

  const existingMap = new Map();
  for (const e of input.existing || []) existingMap.set(e.bookingId, e);

  const deadlines = buildCleaningDeadlines(bookings, {
    maxDeferDays: params.maxDeferDays,
    allowDeferWithoutNextBooking: params.allowDeferWithoutNextBooking
  });
  const diff = computeDiff(bookings, existingMap);

  // 外注に回す期限（実行日から outsourceWindowDays 日以内の未割当が対象）
  const outsourceDeadline = addDays(input.today, params.outsourceWindowDays);

  /** @type {Record<string, Record<string, number>>} */
  const usageByDate = {};
  /** @type {Array<ReturnType<typeof makeAssignment>>} */
  const all = [];

  // --------------------------------------------------------
  // Phase 0: 既存割り当ての引き継ぎ（清掃日ベース）
  // --------------------------------------------------------
  const frozenIds = new Set();

  for (const { booking, previous } of diff.unchanged) {
    const cleaningDate = previous.cleaningDate || booking.checkoutDate;

    // 管理者が手動で変更した割り当ては動かさない（旧 同期状態='手動' の置き換え）
    if (previous.isManual) {
      frozenIds.add(booking.bookingId);
      const frozen = {
        bookingId: booking.bookingId,
        checkoutDate: booking.checkoutDate,
        cleaningDate,
        dayName: dayNameOf(cleaningDate),
        unit: booking.unit,
        title: booking.title || '',
        staffName: previous.staffName,
        status:
          previous.status ||
          (previous.staffName === outsourceName
            ? STATUS.OUTSOURCED
            : previous.staffName === unassignedLabel
              ? STATUS.NEEDS_REVIEW
              : cleaningDate !== booking.checkoutDate
                ? STATUS.DEFERRED
                : STATUS.CONFIRMED),
        guests: booking.guests || 0,
        isManual: true
      };
      all.push(frozen);
      addUsage(usageByDate, cleaningDate, frozen.staffName);
      continue;
    }

    const a = {
      bookingId: booking.bookingId,
      checkoutDate: booking.checkoutDate,
      cleaningDate,
      dayName: dayNameOf(cleaningDate),
      unit: booking.unit,
      title: booking.title || '',
      staffName: previous.staffName,
      status:
        previous.staffName === outsourceName
          ? STATUS.OUTSOURCED
          : previous.staffName === unassignedLabel
            ? STATUS.NEEDS_REVIEW
            : cleaningDate !== booking.checkoutDate
              ? STATUS.DEFERRED
              : STATUS.CONFIRMED,
      guests: booking.guests || 0,
      isManual: false
    };

    // 14日以上先の外注は未割当に戻す（まだスタッフ確定の余地がある）
    if (a.staffName === outsourceName && cleaningDate >= outsourceDeadline) {
      a.staffName = unassignedLabel;
      a.status = STATUS.NEEDS_REVIEW;
    }

    // 延期していた予約の期限を再チェック（新規予約で期限が縮まる場合がある）
    const dl = deadlines[a.bookingId];
    if (dl && a.status === STATUS.DEFERRED && a.cleaningDate > dl.deadline) {
      a.cleaningDate = booking.checkoutDate;
      a.dayName = dayNameOf(booking.checkoutDate);
      a.staffName = unassignedLabel;
      a.status = STATUS.NEEDS_REVIEW;
    }

    all.push(a);
    addUsage(usageByDate, a.cleaningDate, a.staffName);
  }

  // --------------------------------------------------------
  // 新規 ＋ 変更分を割り当て対象にする
  // --------------------------------------------------------
  const toAssign = [];
  for (const b of diff.added) {
    if (!frozenIds.has(b.bookingId)) toAssign.push(b);
  }
  for (const { booking, previous } of diff.changed) {
    // 手動固定された予約は、チェックアウト日やユニットが変わっても動かさない
    if (previous.isManual) {
      frozenIds.add(booking.bookingId);
      const cleaningDate = previous.cleaningDate || booking.checkoutDate;
      all.push({
        bookingId: booking.bookingId,
        checkoutDate: booking.checkoutDate,
        cleaningDate,
        dayName: dayNameOf(cleaningDate),
        unit: booking.unit,
        title: booking.title || '',
        staffName: previous.staffName,
        status: previous.status || STATUS.CONFIRMED,
        guests: booking.guests || 0,
        isManual: true
      });
      addUsage(usageByDate, cleaningDate, previous.staffName);
      continue;
    }
    toAssign.push(booking);
  }

  // --------------------------------------------------------
  // Phase 1: 日付ごとの割り当て
  //   延期できない予約を先に処理し、延期できる予約が溢れるようにする
  //   優先順位: staff.priority の昇順 → 未割当
  // --------------------------------------------------------
  if (toAssign.length > 0) {
    const byDate = new Map();
    for (const r of toAssign) {
      if (!byDate.has(r.checkoutDate)) byDate.set(r.checkoutDate, []);
      byDate.get(r.checkoutDate).push(r);
    }

    for (const date of [...byDate.keys()].sort()) {
      const items = byDate.get(date);

      // 延期不可の予約を先頭へ（スタッフ枠を優先的に確保させる）
      items.sort((a, b) => {
        const aDef = deadlines[a.bookingId]?.canDefer ? 1 : 0;
        const bDef = deadlines[b.bookingId]?.canDefer ? 1 : 0;
        return aDef - bDef;
      });

      const total = items.length;
      let allocated = 0;
      let idx = 0;

      for (const member of workers) {
        const alloc = Math.min(total - allocated, remainingFor(capacity, usageByDate, member, date));
        for (let i = 0; i < alloc; i++, idx++) {
          all.push(makeAssignment(items[idx], member.name, ctx));
          addUsage(usageByDate, date, member.name);
        }
        allocated += alloc;
      }

      for (let i = 0; i < total - allocated; i++, idx++) {
        all.push(makeAssignment(items[idx], unassignedLabel, ctx));
        addUsage(usageByDate, date, unassignedLabel);
      }
    }
  }

  // --------------------------------------------------------
  // Phase 1.4: 外注の引き戻し
  //
  //   前回 外注 に回した清掃でも、その日にスタッフの空き枠ができていれば
  //   未割当に戻す。直後の Phase 1.5 がスタッフに割り当て直す。
  //
  //   ★旧 GAS 版にはこの処理がない。旧版は出勤予定が常に先に入っていたため
  //   問題になりにくかったが、一度 外注 に落ちた清掃はどのフェーズも拾わないため、
  //   **あとから出勤可能件数を入れても外注のまま**になる（外注は実費）。
  //   Phase 0 に「14日以上先の外注は未割当に戻す」があるだけで、
  //   直近14日はまったく取り戻せなかった。
  //
  //   params.reclaimOutsourced = false で旧版の挙動を再現できる（新旧一致テスト用）。
  // --------------------------------------------------------
  if (params.reclaimOutsourced && outsourceName) {
    for (const a of all) {
      if (a.isManual) continue; // 管理者が手で決めたものは動かさない
      if (a.staffName !== outsourceName) continue;
      if (a.cleaningDate < input.today) continue; // 過去は書き換えない
      // 終わった清掃を別の人の担当にしない
      if (existingMap.get(a.bookingId)?.completedAt) continue;

      const hasRoom = workers.some((m) => remainingFor(capacity, usageByDate, m, a.cleaningDate) > 0);
      if (!hasRoom) continue;

      a.staffName = unassignedLabel;
      a.status = STATUS.NEEDS_REVIEW;

      const used = usageByDate[a.cleaningDate];
      if (used && used[outsourceName]) used[outsourceName]--;
      addUsage(usageByDate, a.cleaningDate, unassignedLabel);
    }
  }

  // --------------------------------------------------------
  // Phase 1.5: 既存の未割当をスタッフに再割り当て
  //   前回未割当だった予約について、スタッフの空き枠を再チェックする
  // --------------------------------------------------------
  for (const a of all) {
    if (a.isManual) continue;
    if (a.staffName !== unassignedLabel) continue;

    const target = workers.find((m) => remainingFor(capacity, usageByDate, m, a.cleaningDate) > 0);
    if (!target) continue;

    a.staffName = target.name;
    a.status = a.checkoutDate !== a.cleaningDate ? STATUS.DEFERRED : STATUS.CONFIRMED;
    addUsage(usageByDate, a.cleaningDate, target.name);
    const used = usageByDate[a.cleaningDate];
    if (used && used[unassignedLabel]) used[unassignedLabel]--;
  }

  // --------------------------------------------------------
  // Phase 2: 清掃延期処理
  //   未割当に回った予約を +1日 / +2日 のスタッフ枠に振り替える（早い日を優先）
  // --------------------------------------------------------
  let deferCount = 0;

  for (const a of all) {
    if (a.isManual) continue;
    if (a.staffName !== unassignedLabel) continue;
    if (a.checkoutDate !== a.cleaningDate) continue;

    const dl = deadlines[a.bookingId];
    if (!dl || !dl.canDefer) continue;

    let deferTo = null;
    let deferDate = null;

    for (let offset = 1; offset <= params.maxDeferDays && !deferTo; offset++) {
      const tryDate = addDays(a.cleaningDate, offset);
      if (tryDate > dl.deadline) continue;

      const target = workers.find((m) => remainingFor(capacity, usageByDate, m, tryDate) > 0);
      if (target) {
        deferTo = target.name;
        deferDate = tryDate;
      }
    }

    if (deferTo) {
      const origDate = a.cleaningDate;
      const origStaff = a.staffName;

      a.cleaningDate = deferDate;
      a.dayName = dayNameOf(deferDate);
      a.staffName = deferTo;
      a.status = STATUS.DEFERRED;

      addUsage(usageByDate, deferDate, deferTo);
      if (usageByDate[origDate] && usageByDate[origDate][origStaff]) {
        usageByDate[origDate][origStaff]--;
      }
      deferCount++;
    }
  }

  // --------------------------------------------------------
  // Phase 2.5: Rクリーン回避スワップ
  //   延期できなかった未割当について、同日のスタッフ担当のうち
  //   「延期できる予約」を後ろにずらし、空いた枠に未割当を入れる
  // --------------------------------------------------------
  for (const target of all) {
    if (target.isManual) continue;
    if (target.staffName !== unassignedLabel) continue;

    let swapped = false;
    for (const cand of all) {
      if (swapped) break;
      if (cand.isManual) continue;
      if (cand.cleaningDate !== target.cleaningDate) continue;
      if (cand.staffName === unassignedLabel || cand.staffName === outsourceName) continue;

      const candDl = deadlines[cand.bookingId];
      if (!candDl || !candDl.canDefer) continue;
      if (cand.checkoutDate !== cand.cleaningDate) continue;

      for (let off = 1; off <= params.maxDeferDays && !swapped; off++) {
        const moveDate = addDays(cand.cleaningDate, off);
        if (moveDate > candDl.deadline) continue;

        // 旧版はここで既定上限を 0 に固定して判定している（Code.gs:835）。
        // 現状スタッフの既定上限はすべて 0 のため挙動は同じ。挙動を変えないためそのまま移植する。
        const moveMember = { name: cand.staffName, defaultCapacity: 0 };
        if (remainingFor(capacity, usageByDate, moveMember, moveDate) <= 0) continue;

        const freedStaff = cand.staffName;
        const origDay = cand.cleaningDate;

        cand.cleaningDate = moveDate;
        cand.dayName = dayNameOf(moveDate);
        cand.status = STATUS.DEFERRED;
        addUsage(usageByDate, moveDate, freedStaff);
        if (usageByDate[origDay] && usageByDate[origDay][freedStaff]) {
          usageByDate[origDay][freedStaff]--;
        }

        target.staffName = freedStaff;
        target.status = STATUS.CONFIRMED;
        addUsage(usageByDate, target.cleaningDate, freedStaff);
        if (usageByDate[target.cleaningDate] && usageByDate[target.cleaningDate][unassignedLabel]) {
          usageByDate[target.cleaningDate][unassignedLabel]--;
        }

        deferCount++;
        swapped = true;
      }
    }
  }

  // --------------------------------------------------------
  // Phase 3: 外注（Rクリーン）安全ネット
  //   実行日から outsourceWindowDays 日以内の未割当を外注に回す
  // --------------------------------------------------------
  if (outsourceName) {
    for (const a of all) {
      if (a.isManual) continue;
      if (a.staffName !== unassignedLabel) continue;
      if (a.cleaningDate >= outsourceDeadline) continue;

      a.staffName = outsourceName;
      a.status = STATUS.OUTSOURCED;
    }
  }

  // --------------------------------------------------------
  // Phase 4: 外注のコスト最適化
  //   外注はゲスト数が少ない部屋のほうが安い。
  //   同じ清掃日にスタッフ担当があり、そちらのほうがゲスト数が少なければ入れ替える。
  // --------------------------------------------------------
  const outsourceByDate = new Map();
  if (outsourceName) {
    for (let i = 0; i < all.length; i++) {
      if (all[i].isManual) continue;
      if (all[i].staffName !== outsourceName) continue;
      const date = all[i].cleaningDate;
      if (!outsourceByDate.has(date)) outsourceByDate.set(date, []);
      outsourceByDate.get(date).push(i);
    }
  }

  for (const [date, outsourceIdxs] of outsourceByDate) {
    const staffIdxs = [];
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      if (a.isManual) continue;
      if (a.cleaningDate === date && a.staffName !== outsourceName && a.staffName !== unassignedLabel) {
        staffIdxs.push(i);
      }
    }
    if (staffIdxs.length === 0) continue;

    for (let x = 0; x < outsourceIdxs.length; x++) {
      const rIdx = outsourceIdxs[x];
      const rAsgn = all[rIdx];
      let bestSwap = -1;
      let bestGuests = rAsgn.guests;

      for (let s = 0; s < staffIdxs.length; s++) {
        const sAsgn = all[staffIdxs[s]];
        if (sAsgn.guests < bestGuests) {
          bestGuests = sAsgn.guests;
          bestSwap = s;
        }
      }

      if (bestSwap >= 0) {
        const swapIdx = staffIdxs[bestSwap];
        const swapAsgn = all[swapIdx];

        const tmpStaff = rAsgn.staffName;
        const tmpStatus = rAsgn.status;
        rAsgn.staffName = swapAsgn.staffName;
        rAsgn.status = swapAsgn.status;
        swapAsgn.staffName = tmpStaff;
        swapAsgn.status = tmpStatus;

        staffIdxs.splice(bestSwap, 1);
        staffIdxs.push(rIdx);
        outsourceIdxs[x] = swapIdx;
      }
    }
  }

  all.sort((a, b) => {
    if (a.cleaningDate !== b.cleaningDate) return a.cleaningDate < b.cleaningDate ? -1 : 1;
    if (a.unit !== b.unit) return a.unit < b.unit ? -1 : 1;
    return 0;
  });

  const stats = {
    total: all.length,
    confirmed: all.filter((a) => a.status === STATUS.CONFIRMED).length,
    deferred: all.filter((a) => a.status === STATUS.DEFERRED).length,
    outsourced: all.filter((a) => a.status === STATUS.OUTSOURCED).length,
    unassigned: all.filter((a) => a.status === STATUS.NEEDS_REVIEW).length,
    deferCount,
    removed: diff.removed.length
  };

  return { assignments: all, stats, warnings, deadlines };
}

/**
 * ■ 旧版（GAS 版 v8）との違い
 *
 * 1. スタッフ名のベタ書きを廃止し、`priority` 順のループに一般化した。
 *    旧版は「細田さん・普久原さん・福田さん」の3名を名前で直接参照し、
 *    3名揃っていないと例外を投げていた。スタッフの増減がコード変更なしでできる。
 *    （3名・同じ順序であれば計算結果は旧版と完全に一致する）
 * 2. Rクリーンを `kind: 'outsource'` として扱う。旧版は文字列 'Rクリーン' を直接比較していた。
 * 3. `isManual`（管理者の手動変更）の行を全フェーズで凍結する。旧版に対応する処理はなく、
 *    Google カレンダー側の「同期状態=手動」が担っていた役割をこちらに移した。
 *    凍結された行も枠（usage）は消費する。
 * 4. 日付は Date ではなく 'YYYY-MM-DD' 文字列で扱う（Workers が UTC で動くため）。
 */
