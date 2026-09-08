/**
 * 担当者マスタ（旧 設定シート A3:C6）
 */

import { nowIso } from '../core/dates.js';

function toStaff(row) {
  return {
    id: row.id,
    name: row.name,
    shortName: row.short_name,
    kind: row.kind,
    priority: row.priority,
    defaultCapacity: row.default_capacity,
    usesAvailability: row.uses_availability === 1,
    color: row.color,
    isActive: row.is_active === 1
  };
}

export async function listStaff(db, { includeInactive = false } = {}) {
  const sql = includeInactive
    ? 'SELECT * FROM staff ORDER BY priority, id'
    : 'SELECT * FROM staff WHERE is_active = 1 ORDER BY priority, id';
  const { results } = await db.prepare(sql).all();
  return results.map(toStaff);
}

export async function getStaffByName(db, name) {
  const row = await db.prepare('SELECT * FROM staff WHERE name = ?').bind(name).first();
  return row ? toStaff(row) : null;
}

export async function getStaffById(db, id) {
  const row = await db.prepare('SELECT * FROM staff WHERE id = ?').bind(id).first();
  return row ? toStaff(row) : null;
}

/** 出勤可能件数を自分で入力する担当者（＝Rクリーンを除く） */
export async function listAvailabilityStaff(db) {
  const all = await listStaff(db);
  return all.filter((s) => s.usesAvailability);
}

/**
 * 割り当てエンジン（core/assign.js）に渡す形に変換する。
 * エンジン側はDBを知らないので、ここで橋渡しする。
 */
export function toAssignStaff(staffList) {
  return staffList.map((s) => ({
    name: s.name,
    priority: s.priority,
    kind: s.kind,
    defaultCapacity: s.defaultCapacity
  }));
}

export async function createStaff(db, staff, at = nowIso()) {
  const result = await db
    .prepare(
      `INSERT INTO staff (name, short_name, kind, priority, default_capacity, uses_availability, color, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .bind(
      staff.name,
      staff.shortName ?? staff.name.charAt(0),
      staff.kind ?? 'staff',
      staff.priority,
      staff.defaultCapacity ?? 0,
      staff.usesAvailability === false ? 0 : 1,
      staff.color ?? null,
      at,
      at
    )
    .run();
  return result.meta.last_row_id;
}

export async function updateStaff(db, id, patch, at = nowIso()) {
  const fields = [];
  const values = [];
  const map = {
    name: 'name',
    shortName: 'short_name',
    kind: 'kind',
    priority: 'priority',
    defaultCapacity: 'default_capacity',
    usesAvailability: 'uses_availability',
    color: 'color',
    isActive: 'is_active'
  };

  for (const [key, column] of Object.entries(map)) {
    if (patch[key] === undefined) continue;
    fields.push(`${column} = ?`);
    const value = patch[key];
    values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }
  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(at, id);

  await db.prepare(`UPDATE staff SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
}
