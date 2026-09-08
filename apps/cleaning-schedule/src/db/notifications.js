/**
 * 通知（Slack Webhook 送信ログ・スロットル・管理画面バナーの元）
 *
 * v8 の設計を引き継ぐ:
 *   - 同じ種類の通知は既定12時間に1回まで
 *   - 送信の成否によらず、まずDBに記録する（管理画面に必ず出る）
 *
 * 外部サービス（Slack）が落ちていても、管理画面を開けば異常が分かる状態を保つ。
 */

import { nowIso } from '../core/dates.js';

export const THROTTLE_HOURS = 12;

/**
 * 通知を記録する。直近に同種の通知があればスキップする。
 * @returns {Promise<{recorded: boolean, id?: number, reason?: string}>}
 */
export async function recordNotification(
  db,
  { kind, level = 'warn', subject, body },
  { throttleHours = THROTTLE_HOURS, at = nowIso() } = {}
) {
  const since = new Date(Date.parse(at) - throttleHours * 3600 * 1000).toISOString();

  const recent = await db
    .prepare('SELECT id FROM notifications WHERE kind = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1')
    .bind(kind, since)
    .first();

  if (recent) return { recorded: false, reason: 'throttled' };

  const result = await db
    .prepare('INSERT INTO notifications (kind, level, subject, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(kind, level, subject, body, at)
    .run();

  return { recorded: true, id: result.meta.last_row_id };
}

export async function markSent(db, id, { error = null, at = nowIso() } = {}) {
  await db
    .prepare('UPDATE notifications SET sent_at = ?, send_error = ? WHERE id = ?')
    .bind(error ? null : at, error, id)
    .run();
}

/** 管理画面のバナーに出す未確認の警告 */
export async function listUnacknowledged(db, limit = 20) {
  const { results } = await db
    .prepare(
      `SELECT * FROM notifications
        WHERE acknowledged_at IS NULL AND level IN ('warn','error')
        ORDER BY created_at DESC LIMIT ?`
    )
    .bind(limit)
    .all();
  return results;
}

export async function acknowledge(db, id, at = nowIso()) {
  await db.prepare('UPDATE notifications SET acknowledged_at = ? WHERE id = ?').bind(at, id).run();
}

export async function acknowledgeKind(db, kind, at = nowIso()) {
  await db
    .prepare('UPDATE notifications SET acknowledged_at = ? WHERE kind = ? AND acknowledged_at IS NULL')
    .bind(at, kind)
    .run();
}

export async function listNotifications(db, limit = 50) {
  const { results } = await db
    .prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?')
    .bind(limit)
    .all();
  return results;
}
