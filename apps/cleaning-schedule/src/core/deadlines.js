/**
 * 清掃期限の算出
 *
 * 旧 GAS 版 `buildCleaningDeadlines_`（Code.gs:477-527）の移植。
 *
 *   清掃期限 = min(同じユニットの次の予約の開始日 - 1日, チェックアウト日 + 2日)
 *
 * 上限の +2日 は害虫防止のため（ゴミを放置しない）。
 * 次の予約がなければ +2日 まで延期できる。
 *
 * 【旧 GAS 版からの修正】
 * 旧版は次の予約が見つからない場合に期限をチェックアウト当日のままにしており、
 * 1日も延期できなかった（Code.gs:488, 500-509）。上の式の実装漏れであり、
 * 次の予約がないユニットこそ延期しても支障がないのに外注へ流れていた。
 * 経営者に確認のうえ修正した（docs/decisions.md 2026-09-08 参照）。
 *
 * `allowDeferWithoutNextBooking: false` を渡すと旧版と同じ挙動になる。
 * これは新旧一致テスト（parity）専用のスイッチで、本番では使わない。
 */

import { addDays } from './dates.js';

/**
 * @param {Array<{bookingId:string, unit:string, checkoutDate:string, startDate?:string|null}>} bookings
 * @param {{maxDeferDays?: number}} [options]
 * @returns {Record<string, {deadline: string, canDefer: boolean}>} bookingId をキーとする期限
 */
export function buildCleaningDeadlines(bookings, options = {}) {
  const maxDeferDays = options.maxDeferDays ?? 2;
  const allowDeferWithoutNextBooking = options.allowDeferWithoutNextBooking ?? true;

  const byUnit = new Map();
  for (const b of bookings) {
    if (!byUnit.has(b.unit)) byUnit.set(b.unit, []);
    byUnit.get(b.unit).push(b);
  }

  /** @type {Record<string, {deadline: string, canDefer: boolean}>} */
  const deadlines = {};

  for (const list of byUnit.values()) {
    for (const bk of list) {
      let deadline = bk.checkoutDate;

      // 次の予約の開始日を探す（同ユニット内で最も早い開始日 >= チェックアウト日）
      let earliestNext = null;
      for (const other of list) {
        if (other === bk) continue;
        if (!other.startDate) continue;
        if (other.startDate >= bk.checkoutDate) {
          if (earliestNext === null || other.startDate < earliestNext) {
            earliestNext = other.startDate;
          }
        }
      }
      if (earliestNext !== null) {
        deadline = addDays(earliestNext, -1);
      } else if (allowDeferWithoutNextBooking) {
        deadline = addDays(bk.checkoutDate, maxDeferDays);
      }

      // 害虫防止: 清掃期限はチェックアウト + maxDeferDays が上限
      const maxDefer = addDays(bk.checkoutDate, maxDeferDays);
      if (deadline > maxDefer) deadline = maxDefer;

      // 期限がチェックアウト日より前になる場合は当日が期限
      if (deadline < bk.checkoutDate) deadline = bk.checkoutDate;

      deadlines[bk.bookingId] = {
        deadline,
        canDefer: deadline > bk.checkoutDate
      };
    }
  }

  return deadlines;
}
