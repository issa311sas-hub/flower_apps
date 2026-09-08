/**
 * 前回の割り当てと今回の予約データの差分計算
 *
 * 旧 GAS 版 `computeDiff_`（Code.gs:362-391）の移植。
 *
 * 変更の判定に使うのは「チェックアウト日」と「ユニット」だけ。
 * タイトル（特殊要望）の変更では再割り当てしない（v7 で意図的にそうした。
 * 表記ゆれだけで予定が作り直されるのを防ぐため）。
 */

/**
 * @param {Array<{bookingId:string, checkoutDate:string, unit:string}>} bookings 今回の予約
 * @param {Map<string, {bookingId:string, checkoutDate:string, unit:string}>} existing 前回の割り当て
 */
export function computeDiff(bookings, existing) {
  const seen = new Set();
  const added = [];
  const changed = [];
  const unchanged = [];

  for (const b of bookings) {
    seen.add(b.bookingId);
    const prev = existing.get(b.bookingId);
    if (!prev) {
      added.push(b);
    } else if (prev.checkoutDate !== b.checkoutDate || prev.unit !== b.unit) {
      changed.push({ booking: b, previous: prev });
    } else {
      unchanged.push({ booking: b, previous: prev });
    }
  }

  const removed = [];
  for (const [id, prev] of existing) {
    if (!seen.has(id)) removed.push(prev);
  }

  return { added, changed, unchanged, removed };
}
