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
  return (await getAvailabilityMaps(db, { from, to })).capacity;
}

/**
 * 割り当てエンジンに渡す2つの表を、1回の問い合わせで返す。
 *
 * - `capacity`      … { スタッフ名: { 'YYYY-MM-DD': 件数 } }
 * - `checkinLimits` … { スタッフ名: { 'YYYY-MM-DD': 上限 } }
 *
 * `checkinLimits` に載るのは「13:30」のように**当日チェックインのある部屋の
 * 件数に上限がある日だけ**。ふつうの 0〜5 の入力は載らない（＝上限なし）。
 * 分けてあるのは、エンジンの総数の判定をいっさい変えずに済ませるため。
 */
export async function getAvailabilityMaps(db, { from, to }) {
  const { results } = await db
    .prepare(
      `SELECT s.name AS name, a.date AS date, a.capacity AS capacity, a.checkin_limit AS checkin_limit
         FROM availability a
         JOIN staff s ON s.id = a.staff_id
        WHERE a.date BETWEEN ? AND ?`
    )
    .bind(from, to)
    .all();

  const capacity = {};
  const checkinLimits = {};

  for (const row of results) {
    if (!capacity[row.name]) capacity[row.name] = {};
    capacity[row.name][row.date] = row.capacity;

    if (row.checkin_limit !== null && row.checkin_limit !== undefined) {
      if (!checkinLimits[row.name]) checkinLimits[row.name] = {};
      checkinLimits[row.name][row.date] = row.checkin_limit;
    }
  }

  return { capacity, checkinLimits };
}

/** 1人分の入力状況（画面表示用） */
export async function listForStaff(db, staffId, { from, to }) {
  const { results } = await db
    .prepare(
      `SELECT date, capacity, checkin_limit FROM availability
        WHERE staff_id = ? AND date BETWEEN ? AND ? ORDER BY date`
    )
    .bind(staffId, from, to)
    .all();

  const map = {};
  for (const row of results) {
    map[row.date] = { capacity: row.capacity, checkinLimit: row.checkin_limit ?? null };
  }
  return map;
}

export async function setCapacity(
  db,
  staffId,
  date,
  capacity,
  { checkinLimit = null, updatedBy = null, at = nowIso() } = {}
) {
  await db
    .prepare(
      `INSERT INTO availability (staff_id, date, capacity, checkin_limit, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(staff_id, date) DO UPDATE SET
         capacity      = excluded.capacity,
         checkin_limit = excluded.checkin_limit,
         updated_by    = excluded.updated_by,
         updated_at    = excluded.updated_at`
    )
    .bind(staffId, date, capacity, checkinLimit, updatedBy, at)
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
          `INSERT INTO availability (staff_id, date, capacity, checkin_limit, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(staff_id, date) DO UPDATE SET
             capacity      = excluded.capacity,
             checkin_limit = excluded.checkin_limit,
             updated_by    = excluded.updated_by,
             updated_at    = excluded.updated_at`
        )
        .bind(staffId, e.date, e.capacity, e.checkinLimit ?? null, updatedBy, at)
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

/**
 * その月の最終更新（誰がいつ入れたか）。
 *
 * 管理者の代理入力を足したので、画面の数字が**本人の入力なのか
 * 管理者が代わりに入れたものなのか**が見分けられなくなった。
 * 見分けられないまま上書きできる状態は危ないので、ここで引けるようにする。
 */
export async function lastUpdatedFor(db, staffId, { from, to }) {
  const row = await db
    .prepare(
      `SELECT a.updated_at AS at, u.display_name AS byName, u.role AS byRole
         FROM availability a
         LEFT JOIN users u ON u.id = a.updated_by
        WHERE a.staff_id = ? AND a.date BETWEEN ? AND ?
        ORDER BY a.updated_at DESC
        LIMIT 1`
    )
    .bind(staffId, from, to)
    .first();

  return row ? { at: row.at, byName: row.byName ?? null, byRole: row.byRole ?? null } : null;
}
