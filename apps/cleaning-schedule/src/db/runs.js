/**
 * 実行ログ（Apps Script の「実行数」画面の置き換え）
 *
 * v8 で追加した稼働監視の考え方を引き継ぐ。
 * 「最後に正常終了したのはいつか」を記録し、滞留を検知できるようにする。
 */

import { nowIso, jstToday, diffDays } from '../core/dates.js';
import { setSetting, getSetting } from './settings.js';

export async function startRun(db, kind, { triggeredBy = null, at = nowIso() } = {}) {
  const result = await db
    .prepare('INSERT INTO runs (kind, started_at, triggered_by) VALUES (?, ?, ?)')
    .bind(kind, at, triggeredBy)
    .run();
  return result.meta.last_row_id;
}

export async function finishRun(db, runId, { ok, stats = {}, message = null, error = null, at = nowIso() } = {}) {
  await db
    .prepare(
      `UPDATE runs
          SET finished_at = ?, ok = ?, fetched = ?, assigned = ?, confirmed = ?,
              deferred = ?, outsourced = ?, unassigned = ?, message = ?, error = ?
        WHERE id = ?`
    )
    .bind(
      at,
      ok ? 1 : 0,
      stats.fetched ?? null,
      stats.total ?? null,
      stats.confirmed ?? null,
      stats.deferred ?? null,
      stats.outsourced ?? null,
      stats.unassigned ?? null,
      message,
      error,
      runId
    )
    .run();

  if (ok) await setSetting(db, 'last_success_run_at', at, at);
}

export async function listRuns(db, limit = 30) {
  const { results } = await db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').bind(limit).all();
  return results;
}

export async function getRun(db, id) {
  return db.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first();
}

/**
 * 自動実行が滞っていないかを返す。
 * 旧版では runAllAuto がエラーを握りつぶし、Apps Script からは正常終了に見えたため
 * 停止に誰も気づけなかった。その再発防止のための判定。
 */
export async function getRunHealth(db, nowMs = Date.now()) {
  const lastSuccessAt = await getSetting(db, 'last_success_run_at', '');
  const staleAfter = (await getSetting(db, 'stale_run_alert_days', 3)) || 3;

  if (!lastSuccessAt) {
    return { lastSuccessAt: null, staleDays: null, isStale: false, neverRun: true };
  }

  const staleDays = diffDays(jstToday(Date.parse(lastSuccessAt)), jstToday(nowMs));
  return {
    lastSuccessAt,
    staleDays,
    isStale: staleDays >= staleAfter,
    neverRun: false
  };
}
