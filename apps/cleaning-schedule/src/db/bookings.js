/**
 * 予約データ（旧 予約データシート）
 *
 * Beds24 から取得した予約を保存する。取得結果から消えた予約は
 * 削除せず `state='cancelled'` にする（キャンセルの記録を残すため）。
 */

import { nowIso } from '../core/dates.js';

function toBooking(row) {
  return {
    bookingId: row.booking_id,
    title: row.title || '',
    startDate: row.start_date || null,
    checkoutDate: row.checkout_date,
    unit: row.unit_name,
    guests: row.guests || 0,
    state: row.state
  };
}

/** 割り当て対象の予約（有効なもの）。checkout_date の昇順 */
export async function listActiveBookings(db, { from = null } = {}) {
  const sql = from
    ? `SELECT * FROM bookings WHERE state = 'active' AND checkout_date >= ? ORDER BY checkout_date, unit_name`
    : `SELECT * FROM bookings WHERE state = 'active' ORDER BY checkout_date, unit_name`;
  const stmt = from ? db.prepare(sql).bind(from) : db.prepare(sql);
  const { results } = await stmt.all();
  return results.map(toBooking);
}

export async function getBooking(db, bookingId) {
  const row = await db.prepare('SELECT * FROM bookings WHERE booking_id = ?').bind(bookingId).first();
  return row ? toBooking(row) : null;
}

/**
 * Beds24 の取得結果を反映する。
 *
 * - 既存の予約は更新、新規は追加
 * - 取得範囲内にあるのに応答に含まれなくなった予約は cancelled にする
 *
 * @param {Array<{bookingId,title,startDate,checkoutDate,unit,guests,rawRoomId?,rawUnitId?}>} fetched
 * @param {{from: string, to: string}} range 取得対象期間（この範囲外の予約は触らない）
 */
export async function applyFetchedBookings(db, fetched, range, at = nowIso()) {
  const statements = [];

  for (const b of fetched) {
    statements.push(
      db
        .prepare(
          `INSERT INTO bookings
             (booking_id, title, start_date, checkout_date, unit_name, guests, state,
              raw_room_id, raw_unit_id, first_seen_at, last_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
           ON CONFLICT(booking_id) DO UPDATE SET
             title         = excluded.title,
             start_date    = excluded.start_date,
             checkout_date = excluded.checkout_date,
             unit_name     = excluded.unit_name,
             guests        = excluded.guests,
             state         = 'active',
             raw_room_id   = excluded.raw_room_id,
             raw_unit_id   = excluded.raw_unit_id,
             last_seen_at  = excluded.last_seen_at,
             updated_at    = excluded.updated_at`
        )
        .bind(
          b.bookingId,
          b.title || '',
          b.startDate || null,
          b.checkoutDate,
          b.unit,
          b.guests || 0,
          b.rawRoomId ?? null,
          b.rawUnitId ?? null,
          at,
          at,
          at
        )
    );
  }

  // 応答から消えた予約をキャンセル扱いにする（取得期間内のものだけ）
  statements.push(
    db
      .prepare(
        `UPDATE bookings
            SET state = 'cancelled', updated_at = ?
          WHERE state = 'active'
            AND checkout_date BETWEEN ? AND ?
            AND last_seen_at < ?`
      )
      .bind(at, range.from, range.to, at)
  );

  await db.batch(statements);

  const cancelled = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM bookings
        WHERE state = 'cancelled' AND updated_at = ? AND checkout_date BETWEEN ? AND ?`
    )
    .bind(at, range.from, range.to)
    .first('n');

  return { upserted: fetched.length, cancelled: Number(cancelled ?? 0) };
}
