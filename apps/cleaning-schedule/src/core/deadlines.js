/**
 * 清掃期限の算出
 *
 * 旧 GAS 版 `buildCleaningDeadlines_`（Code.gs:477-527）の移植。
 *
 *   清掃期限 = min(同じユニットの次の予約の開始日 - 1日, チェックアウト日 + 2日)
 *
 * 上限の +2日 は害虫防止のため（ゴミを放置しない）。
 *
 * ⚠【現行踏襲の注意点】
 * 上の式のとおりなら「次の予約がない ＝ +2日まで延期できる」はずだが、
 * 旧 GAS 版の実装は次の予約がない場合に**チェックアウト当日を期限**とし、
 * 延期を一切許していない（Code.gs:488, 500-509）。
 * 次の予約がないユニットこそ延期しても運営上支障がないため、これは
 * 不要な外注（Rクリーン）を生んでいる可能性がある。
 *
 * 移植では**まず現行と同じ挙動**を既定とし、
 * `allowDeferWithoutNextBooking: true` で本来の式に切り替えられるようにした。
 * 切り替えるかどうかは経営者の判断（docs/decisions.md 参照）。
 */

import { addDays } from './dates.js';

/**
 * @param {Array<{bookingId:string, unit:string, checkoutDate:string, startDate?:string|null}>} bookings
 * @param {{maxDeferDays?: number}} [options]
 * @returns {Record<string, {deadline: string, canDefer: boolean}>} bookingId をキーとする期限
 */
export function buildCleaningDeadlines(bookings, options = {}) {
  const maxDeferDays = options.maxDeferDays ?? 2;
  const allowDeferWithoutNextBooking = options.allowDeferWithoutNextBooking ?? false;

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
