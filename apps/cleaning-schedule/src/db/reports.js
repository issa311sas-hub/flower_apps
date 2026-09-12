/**
 * 清掃完了報告
 *
 * 旧運用でメッセージ送信していた内容を記録する。
 *
 * ★**現地精算金額**は、お客さんが現地に置いていった追加サービス料金を
 *   清掃員が回収した額。事実上の給与の前払いなので、あとで給与から差し引く。
 *   月ごと・清掃員ごとの合計を出すのがこのテーブルのいちばんの用途。
 *
 * ⚠ 予約がキャンセルされると assignments の行は消える（saveAssignments が削除する）。
 *   **金額の記録まで一緒に消えてはいけない**ので、この表は booking_id に
 *   外部キーを張らず、日付・ユニット・担当者名を自前で持つ。
 */

import { nowIso } from '../core/dates.js';

export const CONDITIONS = [
  { value: 'A', label: 'とてもきれい' },
  { value: 'B', label: '普通' },
  { value: 'C', label: '少し荒れてる' },
  { value: 'F', label: '次回から受け入れ拒否' }
];

export const EQUIPMENT_VALUES = [
  { value: 'ok', label: '◯' },
  { value: 'ng', label: '✕' }
];

export const SERVICE_VALUES = [
  { value: 'none', label: 'なし' },
  { value: 'cleaned', label: 'あり（清掃済）' },
  { value: 'not_cleaned', label: 'あり（未清掃）' }
];

/** 打ち間違いを弾く上限。1回の清掃で回収する額としては十分大きい */
export const MAX_SETTLEMENT_YEN = 1000000;

const VALID_CONDITIONS = new Set(CONDITIONS.map((c) => c.value));
const VALID_EQUIPMENT = new Set(EQUIPMENT_VALUES.map((v) => v.value));
const VALID_SERVICE = new Set(SERVICE_VALUES.map((v) => v.value));

export function isValidCondition(value) {
  return VALID_CONDITIONS.has(String(value));
}

export function isValidAnswer(kind, value) {
  return kind === 'equipment' ? VALID_EQUIPMENT.has(String(value)) : VALID_SERVICE.has(String(value));
}

/**
 * 金額を検証する。空欄は 0 として扱う。
 * @returns {{ok: true, yen: number}|{ok: false, error: string}}
 */
export function parseSettlement(input) {
  const text = String(input ?? '').trim();
  if (text === '') return { ok: true, yen: 0 };

  if (!/^\d+$/.test(text)) return { ok: false, error: '現地精算金額は数字だけで入力してください。' };

  const yen = Number(text);
  if (yen > MAX_SETTLEMENT_YEN) {
    return { ok: false, error: `現地精算金額が大きすぎます（${MAX_SETTLEMENT_YEN.toLocaleString()}円まで）。` };
  }
  return { ok: true, yen };
}

function toReport(row) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    cleaningDate: row.cleaning_date,
    unit: row.unit_name,
    staffId: row.staff_id,
    staffName: row.staff_name,
    condition: row.condition,
    settlementYen: row.settlement_yen ?? 0,
    note: row.note ?? '',
    reportedBy: row.reported_by,
    reportedAt: row.reported_at
  };
}

export async function getReport(db, bookingId) {
  const row = await db.prepare('SELECT * FROM completion_reports WHERE booking_id = ?').bind(bookingId).first();
  if (!row) return null;

  const { results } = await db
    .prepare('SELECT kind, label, value, sort_order FROM report_answers WHERE report_id = ? ORDER BY kind, sort_order')
    .bind(row.id)
    .all();

  return {
    ...toReport(row),
    answers: results.map((a) => ({ kind: a.kind, label: a.label, value: a.value, sortOrder: a.sort_order }))
  };
}

/**
 * 報告を保存する（同じ予約に2回出したら上書き）。
 *
 * @param {{bookingId, cleaningDate, unit, staffId, staffName, condition, settlementYen, note}} report
 * @param {Array<{kind, label, value}>} answers
 */
export async function saveReport(db, report, answers, { userId = null, at = nowIso() } = {}) {
  const existing = await db
    .prepare('SELECT id FROM completion_reports WHERE booking_id = ?')
    .bind(report.bookingId)
    .first('id');

  if (existing) {
    await db
      .prepare(
        `UPDATE completion_reports
            SET cleaning_date = ?, unit_name = ?, staff_id = ?, staff_name = ?,
                condition = ?, settlement_yen = ?, note = ?, updated_at = ?
          WHERE id = ?`
      )
      .bind(
        report.cleaningDate,
        report.unit,
        report.staffId,
        report.staffName,
        report.condition,
        report.settlementYen,
        report.note ?? '',
        at,
        existing
      )
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO completion_reports
           (booking_id, cleaning_date, unit_name, staff_id, staff_name,
            condition, settlement_yen, note, reported_by, reported_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        report.bookingId,
        report.cleaningDate,
        report.unit,
        report.staffId,
        report.staffName,
        report.condition,
        report.settlementYen,
        report.note ?? '',
        userId,
        at,
        at
      )
      .run();
  }

  const id = existing ?? (await db.prepare('SELECT id FROM completion_reports WHERE booking_id = ?').bind(report.bookingId).first('id'));

  const statements = [db.prepare('DELETE FROM report_answers WHERE report_id = ?').bind(id)];
  answers.forEach((a, i) => {
    statements.push(
      db
        .prepare('INSERT INTO report_answers (report_id, kind, label, value, sort_order) VALUES (?, ?, ?, ?, ?)')
        .bind(id, a.kind, a.label, a.value, i)
    );
  });
  await db.batch(statements);

  return { id };
}

export async function deleteReport(db, bookingId) {
  await db.prepare('DELETE FROM completion_reports WHERE booking_id = ?').bind(bookingId).run();
}

/** 期間内の報告（管理画面の一覧） */
export async function listReports(db, { from, to, staffId = null } = {}) {
  const where = ['cleaning_date >= ?', 'cleaning_date <= ?'];
  const values = [from, to];
  if (staffId) {
    where.push('staff_id = ?');
    values.push(staffId);
  }

  const { results } = await db
    .prepare(`SELECT * FROM completion_reports WHERE ${where.join(' AND ')} ORDER BY cleaning_date, unit_name`)
    .bind(...values)
    .all();

  const reports = results.map(toReport);
  if (reports.length === 0) return [];

  // 「設備に✕がある」「未清掃のサービスがある」を一覧で示すために回答も引く
  const { results: answers } = await db
    .prepare(
      `SELECT ra.report_id, ra.kind, ra.label, ra.value
         FROM report_answers ra
         JOIN completion_reports r ON r.id = ra.report_id
        WHERE r.cleaning_date >= ? AND r.cleaning_date <= ?`
    )
    .bind(from, to)
    .all();

  const byId = new Map(reports.map((r) => [r.id, { ...r, answers: [] }]));
  for (const a of answers) {
    byId.get(a.report_id)?.answers.push({ kind: a.kind, label: a.label, value: a.value });
  }

  return [...byId.values()].map((r) => ({
    ...r,
    ngEquipment: r.answers.filter((a) => a.kind === 'equipment' && a.value === 'ng').map((a) => a.label),
    uncleanedServices: r.answers.filter((a) => a.kind === 'service' && a.value === 'not_cleaned').map((a) => a.label)
  }));
}

/**
 * 清掃員ごとの現地精算合計（★給与から差し引く額）
 *
 * @returns {Array<{staffId, staffName, total, count}>}
 */
export async function sumSettlements(db, { from, to } = {}) {
  const { results } = await db
    .prepare(
      // 並び順は他の画面（タイムライン・出勤入力）と同じ担当者の優先順にそろえる
      `SELECT r.staff_id AS staff_id, r.staff_name AS staff_name,
              SUM(r.settlement_yen) AS total,
              COUNT(*) AS count,
              SUM(CASE WHEN r.settlement_yen > 0 THEN 1 ELSE 0 END) AS with_cash
         FROM completion_reports r
         LEFT JOIN staff s ON s.id = r.staff_id
        WHERE r.cleaning_date >= ? AND r.cleaning_date <= ?
        GROUP BY r.staff_id, r.staff_name
        ORDER BY COALESCE(s.priority, 999), r.staff_name`
    )
    .bind(from, to)
    .all();

  return results.map((r) => ({
    staffId: r.staff_id,
    staffName: r.staff_name,
    total: Number(r.total ?? 0),
    count: Number(r.count ?? 0),
    withCash: Number(r.with_cash ?? 0)
  }));
}

/** 1人分の合計（スタッフ本人の画面用） */
export async function sumSettlementsFor(db, staffId, { from, to }) {
  const row = await db
    .prepare(
      `SELECT SUM(settlement_yen) AS total, COUNT(*) AS count
         FROM completion_reports
        WHERE staff_id = ? AND cleaning_date >= ? AND cleaning_date <= ?`
    )
    .bind(staffId, from, to)
    .first();

  return { total: Number(row?.total ?? 0), count: Number(row?.count ?? 0) };
}

/** 報告フォームに出す項目（settings に1行1項目で入っている） */
export function parseItemList(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
