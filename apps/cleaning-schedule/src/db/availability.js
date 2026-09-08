/**
 * 出勤可能件数（Google カレンダーの置き換え）
 *
 * 旧版はスタッフのGoogleカレンダーに終日イベントとして数字を入れてもらい、
 * `getCapacityForDates_`（Code.gs:396-446）で読み取っていた。
 * ここではスタッフが Web 画面から入力した値を返す。
 *
 * 「入力がない日は既定値（スタッフは0＝出勤不可）」というフェイルセーフは
 * 旧版から引き継ぐ。判定は割り当てエンジン側（core/assign.js）で行う。
 */

import { nowIso } from '../core/dates.js';

/**
 * 割り当てエンジンに渡す形 { スタッフ名: { 'YYYY-MM-DD': 件数 } } を返す
 */
export async function getCapacityMap(db, { from, to }) {
  const { results } = await db
    .prepare(
      `SELECT s.name AS name, a.date AS date, a.capacity AS capacity
         FROM availability a
         JOIN staff s ON s.id = a.staff_id
        WHERE a.date BETWEEN ? AND ?`
    )
    .bind(from, to)
    .all();

  const map = {};
  for (const row of results) {
    if (!map[row.name]) map[row.name] = {};
    map[row.name][row.date] = row.capacity;
  }
  return map;
}

/** 1人分の入力状況（画面表示用） */
export async function listForStaff(db, staffId, { from, to }) {
  const { results } = await db
    .prepare(
      `SELECT date, capacity FROM availability
        WHERE staff_id = ? AND date BETWEEN ? AND ? ORDER BY date`
    )
    .bind(staffId, from, to)
    .all();

  const map = {};
  for (const row of results) map[row.date] = row.capacity;
  return map;
}

export async function setCapacity(db, staffId, date, capacity, { updatedBy = null, at = nowIso() } = {}) {
  await db
    .prepare(
      `INSERT INTO availability (staff_id, date, capacity, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(staff_id, date) DO UPDATE SET
         capacity   = excluded.capacity,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`
    )
    .bind(staffId, date, capacity, updatedBy, at)
    .run();
}

/** 1ヶ月分などをまとめて保存する（入力画面は月まとめて1回のPOST） */
export async function setCapacityBulk(db, staffId, entries, { updatedBy = null, at = nowIso() } = {}) {
  const valid = entries.filter((e) => Number.isInteger(e.capacity) && e.capacity >= 0 && e.capacity <= 9);
  if (valid.length === 0) return 0;

  await db.batch(
    valid.map((e) =>
      db
        .prepare(
          `INSERT INTO availability (staff_id, date, capacity, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(staff_id, date) DO UPDATE SET
             capacity   = excluded.capacity,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`
        )
        .bind(staffId, e.date, e.capacity, updatedBy, at)
    )
  );
  return valid.length;
}

export async function clearCapacity(db, staffId, date) {
  await db.prepare('DELETE FROM availability WHERE staff_id = ? AND date = ?').bind(staffId, date).run();
}

/**
 * 入力されていない日数を数える（管理画面で入力漏れを可視化するため）。
 * 旧版では入力漏れがそのまま外注コストになっていたので、ここを見えるようにする。
 */
export async function countMissingDays(db, { from, to }) {
  const staff = await db
    .prepare('SELECT id, name FROM staff WHERE is_active = 1 AND uses_availability = 1')
    .all();

  const out = [];
  for (const s of staff.results) {
    const filled = await db
      .prepare('SELECT COUNT(*) AS n FROM availability WHERE staff_id = ? AND date BETWEEN ? AND ?')
      .bind(s.id, from, to)
      .first('n');
    out.push({ staffId: s.id, name: s.name, filled: Number(filled ?? 0) });
  }
  return out;
}
