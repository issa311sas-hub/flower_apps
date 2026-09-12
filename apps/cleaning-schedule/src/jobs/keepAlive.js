/**
 * 見張り役（旧 GAS 版 v8 の beds24KeepAlive に相当）
 *
 * 日次処理とは**別の時刻**に、別のトリガーで動く。
 * 本処理が壊れていても、こちらが生きていれば異常に気づける。
 *
 *   1. Beds24 のトークンを能動的に使って30日失効を防ぐ
 *   2. 日次処理が何日も成功していなければ通知に積む
 *   3. トークンの失効が近ければ通知に積む
 *   4. 期限切れのログインセッションを掃除する
 *
 * 旧版が静かに止まって誰も気づけなかった件の再発防止がこのジョブの目的。
 */

import { nowIso } from '../core/dates.js';
import { getAccessToken } from '../integrations/beds24.js';
import {
  getAuthStatus,
  REFRESH_TOKEN_EXPIRE_DAYS,
  TOKEN_WARN_DAYS
} from '../db/beds24Auth.js';
import { startRun, finishRun, getRunHealth } from '../db/runs.js';
import { recordNotification } from '../db/notifications.js';

export async function runKeepAlive(env, options = {}) {
  const db = env.DB;
  const nowMs = options.now ?? Date.now();
  const at = nowIso(nowMs);
  const runId = await startRun(db, 'keepalive', { at });

  const notes = [];

  // 見張り役が「自分の仕事をできなかった」ものだけを入れる。
  // 滞留やトークンの期限接近を**見つけた**ことは、見張りの失敗ではない
  // （それを見つけるのが仕事なので、成功として扱う）。
  const failures = [];

  // 1. トークンを能動的に更新する（使わないと30日で失効するため）
  const auth = await getAuthStatus(db, nowMs);
  if (auth.hasToken) {
    try {
      await getAccessToken(db, env.TOKEN_ENC_KEY, { force: true }, {
        fetch: options.fetchImpl,
        now: () => nowMs
      });
      notes.push('トークン更新OK');
    } catch (error) {
      notes.push(`トークン更新に失敗: ${error.message}`);
      failures.push(`トークン更新に失敗: ${error.message}`);
      await recordNotification(
        db,
        {
          kind: error?.permanent ? 'auth_expired' : 'auth_error',
          level: 'error',
          subject: error?.permanent ? 'Beds24 の再接続が必要です' : 'Beds24 への接続に失敗しています',
          body: error.message
        },
        { at }
      );
    }
  } else {
    notes.push('Beds24 未接続');
  }

  // 2. 日次処理が滞っていないか
  const health = await getRunHealth(db, nowMs);
  if (health.isStale) {
    notes.push(`${health.staleDays}日間 正常終了なし`);
    await recordNotification(
      db,
      {
        kind: 'stale_run',
        level: 'error',
        subject: `${health.staleDays}日間、自動実行が成功していません`,
        body:
          `最後に正常終了したのは ${health.lastSuccessAt} です。\n` +
          '管理画面の実行ログでエラー内容を確認してください。\n' +
          '※ この間、清掃予定は更新されていません。'
      },
      { at }
    );
  }

  // 3. トークンの失効が近いか
  if (auth.needsWarning) {
    notes.push(`トークン ${auth.daysSinceOk}日未使用`);
    await recordNotification(
      db,
      {
        kind: 'token_stale',
        level: 'warn',
        subject: 'Beds24 トークンの失効が近づいています',
        body:
          `${auth.daysSinceOk}日間 使用されていません。` +
          `${REFRESH_TOKEN_EXPIRE_DAYS}日で失効し、招待コードからの再接続が必要になります。\n` +
          `残り約 ${auth.daysUntilExpiry}日です。`
      },
      { at }
    );
  }

  // 4. 期限切れセッションの掃除
  const swept = await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(at).run();
  const sweptCount = swept.meta?.changes ?? 0;
  if (sweptCount > 0) notes.push(`期限切れセッション ${sweptCount}件を削除`);

  const message = notes.join(' / ');
  const ok = failures.length === 0;

  // ⚠ 以前はここを無条件に ok:true にしていた。見張り役が滞留の判定時計を
  //   リセットしてしまうのを避けるためだったが、その判定は
  //   `getRunHealth`（kind IN 'cron','manual'）に移り、keepalive は数えなくなった。
  //   古い制約だけが残り、**トークン更新に失敗しても緑の「正常」**と
  //   表示されていた。実行ログを一目見て異常に気づけないなら意味がない。
  await finishRun(db, runId, { ok, message, error: failures.join('\n') || null, at });

  return { ok, runId, message, tokenWarned: auth.needsWarning, stale: health.isStale, sweptCount };
}

export { TOKEN_WARN_DAYS };
