/**
 * ユニットと Beds24 のマッピング（旧 設定シート A19:D以降）
 */

export async function listUnits(db, { includeInactive = false } = {}) {
  const sql = includeInactive
    ? 'SELECT * FROM units ORDER BY sort_order'
    : 'SELECT * FROM units WHERE is_active = 1 ORDER BY sort_order';
  const { results } = await db.prepare(sql).all();
  return results.map((r) => ({
    name: r.name,
    sortOrder: r.sort_order,
    label: r.label,
    isActive: r.is_active === 1,
    note: r.note
  }));
}

/** タイムラインの並び順（b4,b5,b6,b2,b3,s1,s2,s3,c4） */
export async function listUnitNames(db) {
  const units = await listUnits(db);
  return units.map((u) => u.name);
}

export async function listUnitMap(db) {
  const { results } = await db.prepare('SELECT * FROM unit_map ORDER BY room_id, unit_id').all();
  return results.map((r) => ({
    roomId: String(r.room_id),
    unitId: String(r.unit_id ?? ''),
    unitName: r.unit_name,
    note: r.note
  }));
}

/**
 * Beds24 の応答からユニット名を引くための Map を返す。
 * キーは 'roomId:unitId'（旧版 Code.gs:1851 と同じ形）。
 * 1つの roomId に複数の unit がぶら下がる構成があるため、この組で判定する。
 */
export async function getUnitLookup(db) {
  const rows = await listUnitMap(db);
  const lookup = new Map();
  for (const r of rows) lookup.set(`${r.roomId}:${r.unitId}`, r.unitName);
  return lookup;
}

/** マッピングを丸ごと入れ替える（管理画面の保存） */
export async function replaceUnitMap(db, rows) {
  const statements = [db.prepare('DELETE FROM unit_map')];
  for (const r of rows) {
    if (!r.roomId || !r.unitName) continue;
    statements.push(
      db
        .prepare('INSERT INTO unit_map (room_id, unit_id, unit_name, note) VALUES (?, ?, ?, ?)')
        .bind(String(r.roomId), String(r.unitId ?? ''), r.unitName, r.note ?? null)
    );
  }
  await db.batch(statements);
}
