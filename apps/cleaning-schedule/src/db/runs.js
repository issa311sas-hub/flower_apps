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

  // ⚠ ここで last_success_run_at を書いてはいけない。
  //    見張り役（keepAlive）は最後に必ず ok:true で終わるので、
  //    ここに置くと見張り役が毎日、滞留の判定時計をリセットしてしまう。
  //    実際にそうなっていて、「◯日間 成功していません」が永久に出なかった。
  //    表示用の書き込みは runDaily の成功時だけに置いている。
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
/**
 * 滞留の判定に数える実行の種類。
 *
 * 見張り役（keepalive）は**入れない**。あれは監視するだけで予約を取り直さないし、
 * 必ず正常終了するので、入れると「毎日成功している」ことになってしまう。
 */
const DAILY_KINDS = ['cron', 'manual'];

/**
 * 予約取得〜割り当てが滞っていないかを返す。
 *
 * 判定は **runs テーブルの実績から直接**求める。
 * 以前は設定値 last_success_run_at を見ていたが、
 * 見張り役が finishRun 経由でそれを毎日上書きしてしまい、
 * 滞留の警告が永久に出ない状態になっていた（実際に発生した）。
 * 派生した設定値ではなく、実行の記録そのものを見れば取り違えようがない。
 */
export async function getRunHealth(db, nowMs = Date.now()) {
  const placeholders = DAILY_KINDS.map(() => '?').join(', ');
  const lastSuccessAt = await db
    .prepare(
      `SELECT MAX(finished_at) AS last FROM runs
        WHERE ok = 1 AND kind IN (${placeholders})`
    )
    .bind(...DAILY_KINDS)
    .first('last');

  const staleAfter = (await getSetting(db, 'stale_run_alert_days', 3)) || 3;

  if (!lastSuccessAt) {
    // まだ一度も成功していない。「止まった」とは区別して扱う
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

/**
 * Cloudflare の cron から呼ばれているかを返す。
 *
 * 「日次処理が成功したか」（getRunHealth）とは**別の問い**。
 * 呼ばれていないのか、呼ばれたが失敗したのかで、見に行く先も直し方も違う。
 * 以前これを分けていなかったため、朝6時が動かなかったときに
 * 「アプリの問題」か「Cloudflare の問題」かを切り分けられなかった。
 *
 * cron は1日2回動くので、2日空けば確実におかしい。
 */
export const CRON_SILENT_DAYS = 2;

export async function getCronHealth(db, nowMs = Date.now()) {
  const lastEventAt = (await getSetting(db, 'last_cron_event_at', '')) || null;

  if (!lastEventAt) {
    return { lastEventAt: null, silentDays: null, isSilent: false, neverCalled: true };
  }

  const silentDays = diffDays(jstToday(Date.parse(lastEventAt)), jstToday(nowMs));
  return {
    lastEventAt,
    silentDays,
    isSilent: silentDays >= CRON_SILENT_DAYS,
    neverCalled: false
  };
}

/**
 * cron から呼ばれたことを記録する。
 *
 * **本処理より先に、いちばん最初に呼ぶこと。** そのあとで何が落ちても
 * 「Cloudflare は呼んだ」という事実だけは残る。
 * 記録に失敗しても本処理は止めない（記録のために業務を止めない）。
 */
export async function recordCronEvent(db, cron, at = nowIso()) {
  try {
    await setSetting(db, 'last_cron_event_at', at, at);
    await setSetting(db, 'last_cron_expression', String(cron ?? ''), at);
    return true;
  } catch {
    return false;
  }
}
