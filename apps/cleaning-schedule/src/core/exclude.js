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
 * 判定は毎回やり直す。タイトルは取得のたびに上書きされる（db/bookings.js）ので、
 * **あとから Beds24 側で語句を足せば、次の実行で対象外になる**。
 * その分スタッフの枠が空き、外注に回っていた清掃が引き戻される
 * （割り当てエンジンの Phase 1.4 → 1.5）。
 *
 * @param {Array<object>} bookings 取り込み済みの予約
 * @param {string[]} words 除外する語句（空なら何も除外しない）
 * @param {{existing?: Array<object>, today?: string}} options
 *   `existing` すでにある割り当て / `today` 今日（JST, 'YYYY-MM-DD'）
 * @returns {{assignable: Array<object>, excluded: Array<object>}}
 */
export function splitExcluded(bookings, words, { existing = [], today = null } = {}) {
  const list = (words ?? []).map((w) => String(w ?? '').trim()).filter(Boolean);

  // 語句が1つも無ければ何もしない。既定の挙動を変えないための入口
  if (list.length === 0) return { assignable: [...(bookings ?? [])], excluded: [] };

  // ここに入るものは、語句に一致しても対象外にしない。
  // 3つとも割り当てエンジンが全フェーズで守っている決まりと同じもの。
  const protectedIds = new Set(
    (existing ?? [])
      .filter(
        (e) =>
          // 管理者が手で決めた担当を、あとから足した語句で取り上げない
          e.isManual ||
          // ★終わった清掃は動かさない（core/assign.js:309 と同じ）。
          //   実際にやった清掃の担当者が画面から消えると、誰がやったか分からなくなる
          e.completedAt ||
          // ★過去は書き換えない。済んだ日の割り当てをあとから塗り替えると履歴が信用できない
          (today && e.cleaningDate && e.cleaningDate < today)
      )
      .map((e) => e.bookingId)
  );

  const assignable = [];
  const excluded = [];

  for (const booking of bookings ?? []) {
    if (!protectedIds.has(booking.bookingId) && isExcludedTitle(booking.title, list)) {
      excluded.push(booking);
    } else {
      assignable.push(booking);
    }
  }

  return { assignable, excluded };
}

/**
 * いま対象外でない予約に残っている「対象外」の割り当てを、無かったことにする。
 *
 * ★これが無いと、**語句を消しても割り当てが戻らない。**
 *
 * 割り当てエンジンは Phase 0 で前回の担当をそのまま引き継ぐ。
 * 担当が `対象外` のまま渡すと、エンジンはその名前を知らないので
 * どのフェーズも拾わず、永久に `対象外` のまま残る。
 * （一度 外注 に落ちた清掃をどのフェーズも拾わなかったのと同じ形。Phase 1.4 の経緯を参照）
 *
 * 前回の割り当てを消して渡せば、エンジンは新しい予約として決め直す。
 *
 * @param {Array<object>} existing すでにある割り当て
 * @param {Set<string>} excludedIds 今回も対象外になる予約のID
 */
export function forgetExcluded(existing, excludedIds) {
  const stillExcluded = excludedIds ?? new Set();

  return (existing ?? []).filter(
    (e) => !(e.staffName === EXCLUDED_LABEL && !stillExcluded.has(e.bookingId))
  );
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
