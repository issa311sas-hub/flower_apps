/**
 * 割り当て（旧 割り当て結果シート ＋ 同期データベースシート）
 *
 * 旧版では2つのシートに分かれていた。同期データベースは
 * (a) カレンダー同期の台帳 と (b) 前回の割り当ての記憶 を兼ねていたが、
 * カレンダーを廃止したため (b) だけが残り、このテーブルに統合されている。
 *
 * `is_manual` は旧版の「同期状態=手動」に相当する。管理者が手で変えた行を
 * 自動割り当てで上書きしないための印。
 */

import { nowIso } from '../core/dates.js';

function toAssignment(row) {
  return {
    bookingId: row.booking_id,
    checkoutDate: row.checkout_date,
    cleaningDate: row.cleaning_date,
    unit: row.unit_name,
    title: row.title || '',
    staffName: row.staff_name,
    status: row.status,
    nextGuests: row.next_guests || 0,
    isManual: row.is_manual === 1,
    completedAt: row.completed_at || null,
    updatedAt: row.updated_at
  };
}

/** 割り当てエンジンに渡す「前回の状態」 */
export async function loadExisting(db) {
  const { results } = await db.prepare('SELECT * FROM assignments').all();
  return results.map(toAssignment);
}

export async function listAssignments(db, { from = null, to = null, staffName = null } = {}) {
  const where = [];
  const values = [];
  if (from) {
    where.push('cleaning_date >= ?');
    values.push(from);
  }
  if (to) {
    where.push('cleaning_date <= ?');
    values.push(to);
  }
  if (staffName) {
    where.push('staff_name = ?');
    values.push(staffName);
  }

  const sql =
    'SELECT * FROM assignments' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY cleaning_date, unit_name';

  const stmt = values.length ? db.prepare(sql).bind(...values) : db.prepare(sql);
  const { results } = await stmt.all();
  return results.map(toAssignment);
}

export async function getAssignment(db, bookingId) {
  const row = await db.prepare('SELECT * FROM assignments WHERE booking_id = ?').bind(bookingId).first();
  return row ? toAssignment(row) : null;
}

/**
 * 割り当て結果を保存する。
 *
 * - 結果に含まれない予約（キャンセル等）は削除する
 * - 手動固定（is_manual）の印と完了報告は保存後も維持する
 * - 担当・清掃日・ステータスが変わった行は履歴に残す
 *
 * @param {Array} assignments core/assign.js の出力
 * @param {Record<string, number>} nextGuests bookingId → 次のゲスト数
 */
export async function saveAssignments(db, assignments, { nextGuests = {}, runId = null, at = nowIso() } = {}) {
  const before = new Map((await loadExisting(db)).map((a) => [a.bookingId, a]));
  const keep = new Set(assignments.map((a) => a.bookingId));

  const statements = [];
  const history = [];

  for (const a of assignments) {
    const prev = before.get(a.bookingId);
    const guests = nextGuests[a.bookingId] ?? prev?.nextGuests ?? 0;

    if (
      prev &&
      (prev.staffName !== a.staffName ||
        prev.cleaningDate !== a.cleaningDate ||
        prev.status !== a.status)
    ) {
      history.push({ prev, next: a });
    }

    statements.push(
      db
        .prepare(
          `INSERT INTO assignments
             (booking_id, checkout_date, cleaning_date, unit_name, title, staff_name, status,
              next_guests, is_manual, last_run_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(booking_id) DO UPDATE SET
             checkout_date = excluded.checkout_date,
             cleaning_date = excluded.cleaning_date,
             unit_name     = excluded.unit_name,
             title         = excluded.title,
             staff_name    = excluded.staff_name,
             status        = excluded.status,
             next_guests   = excluded.next_guests,
             last_run_id   = excluded.last_run_id,
             updated_at    = excluded.updated_at`
        )
        .bind(
          a.bookingId,
          a.checkoutDate,
          a.cleaningDate,
          a.unit,
          a.title || '',
          a.staffName,
          a.status,
          guests,
          a.isManual ? 1 : 0,
          runId,
          at
        )
    );
  }

  for (const bookingId of before.keys()) {
    if (!keep.has(bookingId)) {
      statements.push(db.prepare('DELETE FROM assignments WHERE booking_id = ?').bind(bookingId));
    }
  }

  for (const { prev, next } of history) {
    statements.push(
      db
        .prepare(
          `INSERT INTO assignment_history
             (booking_id, changed_at, changed_by, run_id, old_staff, new_staff, old_date, new_date, old_status, new_status)
           VALUES (?, ?, 'cron', ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          prev.bookingId,
          at,
          runId,
          prev.staffName,
          next.staffName,
          prev.cleaningDate,
          next.cleaningDate,
          prev.status,
          next.status
        )
    );
  }

  if (statements.length > 0) await db.batch(statements);

  return {
    saved: assignments.length,
    deleted: before.size - [...before.keys()].filter((id) => keep.has(id)).length,
    changed: history.length
  };
}

/**
 * 管理者による手動変更。以降の自動割り当てで動かさない（is_manual=1）。
 * 旧版でGoogleカレンダーを直接編集していた操作の置き換え。
 */
export async function setManual(db, bookingId, patch, { userId = null, changedBy = 'admin', at = nowIso() } = {}) {
  const prev = await getAssignment(db, bookingId);
  if (!prev) return null;

  const staffName = patch.staffName ?? prev.staffName;
  const cleaningDate = patch.cleaningDate ?? prev.cleaningDate;
  const status = patch.status ?? prev.status;

  await db.batch([
    db
      .prepare(
        `UPDATE assignments
            SET staff_name = ?, cleaning_date = ?, status = ?,
                is_manual = 1, manual_by = ?, manual_at = ?, updated_at = ?
          WHERE booking_id = ?`
      )
      .bind(staffName, cleaningDate, status, userId, at, at, bookingId),
    db
      .prepare(
        `INSERT INTO assignment_history
           (booking_id, changed_at, changed_by, run_id, old_staff, new_staff, old_date, new_date, old_status, new_status)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        bookingId,
        at,
        changedBy,
        prev.staffName,
        staffName,
        prev.cleaningDate,
        cleaningDate,
        prev.status,
        status
      )
  ]);

  return getAssignment(db, bookingId);
}

/**
 * すべての割り当てを未割当に戻す（管理画面の「ゼロから割り当て直す」）。
 *
 * 行は消さない。消すと完了報告と手動固定が失われるため、
 * 未割当に戻して清掃日も退去日に戻し、次の自動実行に決め直させる。
 *
 * 触らないもの:
 *   - 手動固定（管理者が手で決めたもの）
 *   - 完了報告済み（終わった清掃）
 *   - `from` より前の清掃日（過去は書き換えない）
 */
export async function resetAllAssignments(db, { from, unassignedLabel = '未割当', status = '要確認', at = nowIso() } = {}) {
  const result = await db
    .prepare(
      `UPDATE assignments
          SET staff_name = ?, status = ?, cleaning_date = checkout_date, updated_at = ?
        WHERE is_manual = 0 AND completed_at IS NULL AND cleaning_date >= ?`
    )
    .bind(unassignedLabel, status, at, from)
    .run();

  return { reset: result.meta?.changes ?? 0 };
}

/** 手動固定を解除する（次回の自動割り当てで再計算される） */
export async function clearManual(db, bookingId, at = nowIso()) {
  await db
    .prepare('UPDATE assignments SET is_manual = 0, manual_by = NULL, manual_at = NULL, updated_at = ? WHERE booking_id = ?')
    .bind(at, bookingId)
    .run();
}

/** スタッフの完了報告 */
export async function markCompleted(db, bookingId, { userId = null, at = nowIso() } = {}) {
  await db
    .prepare('UPDATE assignments SET completed_at = ?, completed_by = ?, updated_at = ? WHERE booking_id = ?')
    .bind(at, userId, at, bookingId)
    .run();
}

export async function clearCompleted(db, bookingId, at = nowIso()) {
  await db
    .prepare('UPDATE assignments SET completed_at = NULL, completed_by = NULL, updated_at = ? WHERE booking_id = ?')
    .bind(at, bookingId)
    .run();
}

export async function listHistory(db, bookingId, limit = 20) {
  const { results } = await db
    .prepare('SELECT * FROM assignment_history WHERE booking_id = ? ORDER BY changed_at DESC LIMIT ?')
    .bind(bookingId, limit)
    .all();
  return results;
}
