/**
 * 割り当ての対象から外す予約の判定
 *
 * Beds24 にレビュー用のダミー予約が入ることがある。これに清掃が割り当てられると、
 * 実在しない清掃がスタッフの予定に出て、外注にも回りうる（＝そのまま費用になる）。
 * タイトルに印を入れておけば対象外にできるようにする。
 *
 * **この判定は割り当てエンジン（core/assign.js）には入れない。**
 * あちらは旧版との一致テスト（parity, 2000シナリオ）で縛ってあり、
 * 挙動を足すと「旧版と同じ」という保証が崩れる。
 * ここで先に振り分け、エンジンにはダミー予約を渡さない。
 *
 * DBもURLも知らない純粋関数だけを置く（test/core/purity.test.js の対象）。
 */

/** 対象外の予約に入れる担当者名。'未割当' と同じく、実在しない担当者名を使う */
export const EXCLUDED_LABEL = '対象外';

/** 対象外の予約の状態 */
export const EXCLUDED_STATUS = '対象外';

/**
 * タイトルに語句のどれかが含まれるか。
 *
 * 部分一致。大文字小文字は区別しない（日本語には影響しないが、
 * 'TEST' と 'test' を別物にしても利用者は得をしない）。
 */
export function isExcludedTitle(title, words) {
  const haystack = String(title ?? '').toLowerCase();
  if (!haystack) return false;

  return (words ?? []).some((word) => {
    const needle = String(word ?? '').trim().toLowerCase();
    return needle !== '' && haystack.includes(needle);
  });
}

/**
 * 予約を「割り当てるもの」と「対象外」に分ける。
 *
 * @param {Array<object>} bookings 取り込み済みの予約
 * @param {string[]} words 除外する語句（空なら何も除外しない）
 * @param {{existing?: Array<{bookingId: string, isManual?: boolean}>}} options
 *   すでにある割り当て。**手動で決めたものは対象外にしない**
 * @returns {{assignable: Array<object>, excluded: Array<object>}}
 */
export function splitExcluded(bookings, words, { existing = [] } = {}) {
  const list = (words ?? []).map((w) => String(w ?? '').trim()).filter(Boolean);

  // 語句が1つも無ければ何もしない。既定の挙動を変えないための入口
  if (list.length === 0) return { assignable: [...(bookings ?? [])], excluded: [] };

  // 管理者が手で担当を決めたものは動かさない。
  // あとから語句を足したせいで、決めたはずの担当が取り上げられるのは筋が悪い。
  // 割り当てエンジンが全フェーズで手動行を避けているのと同じ考え方。
  const manual = new Set((existing ?? []).filter((e) => e.isManual).map((e) => e.bookingId));

  const assignable = [];
  const excluded = [];

  for (const booking of bookings ?? []) {
    if (!manual.has(booking.bookingId) && isExcludedTitle(booking.title, list)) {
      excluded.push(booking);
    } else {
      assignable.push(booking);
    }
  }

  return { assignable, excluded };
}

/**
 * 対象外の予約を、割り当ての行の形にする。
 *
 * 保存も表示も通常の割り当てと同じ経路に乗せたいので、
 * 担当者名と状態だけが違う行として作る（'未割当' と同じやり方）。
 * 清掃日はチェックアウト日のまま。延期の判断はしない（そもそも清掃しないため）。
 */
export function toExcludedAssignment(booking) {
  return {
    bookingId: booking.bookingId,
    checkoutDate: booking.checkoutDate,
    cleaningDate: booking.checkoutDate,
    unit: booking.unit,
    title: booking.title || '',
    staffName: EXCLUDED_LABEL,
    status: EXCLUDED_STATUS,
    guests: booking.guests || 0,
    isManual: false
  };
}
