/**
 * 「次に泊まる人数」の算出
 *
 * 旧 GAS 版ではカレンダー同期の中で計算していた（Code.gs:1044-1075）。
 * カレンダーを廃止したため、割り当て結果として保存する値に移した。
 * スタッフ画面の「次3人」表示に使う（清掃時の準備数の目安）。
 *
 * 清掃日以降に始まる、同じユニットの次の予約の人数。見つからなければ 0。
 */

/**
 * @param {Array<{bookingId:string, unit:string, startDate?:string|null, guests?:number}>} bookings
 * @param {Array<{bookingId:string, unit:string, cleaningDate:string}>} assignments
 * @returns {Record<string, number>} bookingId → 次のゲスト数
 */
export function computeNextGuests(bookings, assignments) {
  const byUnit = new Map();
  for (const b of bookings) {
    if (!b.startDate) continue;
    if (!byUnit.has(b.unit)) byUnit.set(b.unit, []);
    byUnit.get(b.unit).push(b);
  }
  for (const list of byUnit.values()) {
    list.sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
  }

  /** @type {Record<string, number>} */
  const result = {};
  for (const a of assignments) {
    let nextGuests = 0;
    for (const b of byUnit.get(a.unit) || []) {
      if (b.startDate >= a.cleaningDate && b.bookingId !== a.bookingId) {
        nextGuests = b.guests || 0;
        break;
      }
    }
    result[a.bookingId] = nextGuests;
  }
  return result;
}
