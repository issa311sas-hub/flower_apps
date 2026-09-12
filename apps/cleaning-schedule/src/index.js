/**
 * Cloudflare Worker のエントリポイント
 *
 * 画面はサーバー側でHTMLを組み立てて返す（SPAではない）。
 * 利用者は非エンジニアで端末も古いため、初回表示の速さと確実さを優先している。
 */

import { createRouter } from './router.js';
import { html, page, htmlResponse, jsonResponse, redirect } from './web/html.js';
import { getCurrentUser } from './web/auth.js';

import { recordCronEvent } from './db/runs.js';
import { applyMigrations } from './db/migrate.js';
import { recordNotification } from './db/notifications.js';
import { runDaily } from './jobs/dailyRun.js';
import { runKeepAlive } from './jobs/keepAlive.js';
import { flushNotifications } from './jobs/notify.js';

import { showLogin, doLogin, doLogout } from './web/pages/login.js';
import {
  showMySchedule,
  showAvailability,
  saveAvailability,
  showPasswordForm,
  changePassword
} from './web/pages/staff.js';
import {
  showAdminHome,
  showAdminStaff,
  createStaffUser,
  reissuePassword,
  toggleStaffUser
} from './web/pages/admin.js';
import { showBeds24, connectBeds24, discoverUnits, saveUnitMap } from './web/pages/beds24.js';
import { showAssignments } from './web/pages/assignments.js';
import {
  showAssignment,
  updateAssignment,
  releaseAssignment,
  resetAssignment
} from './web/pages/assignment.js';
import { showTimeline } from './web/pages/timeline.js';
import {
  showAvailabilityOverview,
  showStaffAvailability,
  saveStaffAvailability
} from './web/pages/availability.js';
import { showReportForm, saveReportForm, undoReport } from './web/pages/report.js';
import { showReports, showReportDetail } from './web/pages/reports.js';
import { runMigrations } from './web/pages/migrate.js';
import { runNow, showRuns, showRun, ackNotification } from './web/pages/runs.js';
import { showSettings, saveSettings, testNotification } from './web/pages/settings.js';
import { renderSetup, renderKeys } from './web/pages/setup.js';
import { checkHealth } from './web/health.js';

// 適用するマイグレーションの一覧。スキーマの正は migrations/*.sql のまま
import { MIGRATIONS } from './db/migrations.js';

/** 見張り役の cron（UTC 9時 = JST 18時）。wrangler.jsonc と一致させること */
const KEEPALIVE_CRON = '0 9 * * *';

const router = createRouter();

// ルートには**ハンドラをそのまま渡す**。
// router.match は handler(request, env, params) の形で呼ぶので、
//
//   :param のあるパス … handler(request, env, params, options = {})
//   :param のないパス … handler(request, env, options = {})   ← params は {} で届く
//
// どちらも既定値と同じ形になるため、矢印関数で包む必要はない。
// **:param のあるパスのハンドラは、必ず第3引数で params を受けること。**
// ここを間違えると params が options として渡り、静かに動きが変わる。

router.get('/', async (request, env) => {
  const user = await getCurrentUser(request, env);
  if (!user) return redirect('/login');
  return redirect(user.role === 'admin' ? '/admin' : '/me');
});

router.get('/login', showLogin);
router.post('/login', doLogin);
router.post('/logout', doLogout);

router.get('/me', showMySchedule);
router.get('/me/report/:bookingId', showReportForm);
router.post('/me/report/:bookingId', saveReportForm);
router.post('/me/report/:bookingId/undo', undoReport);
router.get('/me/availability', showAvailability);
router.post('/me/availability', saveAvailability);
router.get('/me/password', showPasswordForm);
router.post('/me/password', changePassword);

router.get('/admin', showAdminHome);
router.get('/admin/staff', showAdminStaff);
router.post('/admin/staff', createStaffUser);
router.post('/admin/staff/:id/password', reissuePassword);
router.post('/admin/staff/:id/active', toggleStaffUser);

router.get('/admin/beds24', showBeds24);
router.post('/admin/beds24', connectBeds24);
router.post('/admin/beds24/discover', discoverUnits);
router.post('/admin/beds24/map', saveUnitMap);

router.get('/admin/assignments', showAssignments);
router.get('/admin/assignments/:bookingId', showAssignment);
router.post('/admin/assignments/:bookingId', updateAssignment);
router.post('/admin/assignments/:bookingId/auto', releaseAssignment);
router.post('/admin/assignments/:bookingId/reset', resetAssignment);

router.get('/admin/timeline', showTimeline);
router.get('/admin/availability', showAvailabilityOverview);
router.get('/admin/availability/:staffId', showStaffAvailability);
router.post('/admin/availability/:staffId', saveStaffAvailability);

router.get('/admin/reports', showReports);
router.get('/admin/reports/:bookingId', showReportDetail);

router.get('/admin/settings', showSettings);
router.post('/admin/settings', saveSettings);
router.post('/admin/settings/test', testNotification);

router.post('/admin/migrate', runMigrations);

router.post('/admin/run', runNow);
router.get('/admin/runs', showRuns);
router.get('/admin/runs/:id', showRun);
router.post('/admin/notifications/:id/ack', ackNotification);

router.get('/setup', renderSetup);
router.get('/setup/keys', (request, env) => htmlResponse(renderKeys(env)));
/**
 * 死活監視の窓口。
 *
 * 異常時は **HTTP 503** を返す。無料の監視サービス（UptimeRobot 等）は
 * ステータスコードしか見ないものが多く、これだけで
 * 「システムごと止まった」「自動実行が滞っている」を外から検知できる。
 * Worker 自身が落ちたときは、そもそも応答が返らないので同じく検知される。
 */
router.get('/api/health', async (request, env) => {
  const health = await checkHealth(env);
  return jsonResponse(health, { status: health.ok ? 200 : 503 });
});

/** ルートを引いて実行する。本文の扱い（HEAD）は呼び出し側で整える。 */
async function handle(request, env) {
  const url = new URL(request.url);
  const route = router.match(request.method, url.pathname);

  if (!route) {
    return htmlResponse(
      page({ title: '見つかりません', nav: false, body: '<h2>ページが見つかりません</h2><p><a href="/">最初に戻る</a></p>' }),
      { status: 404 }
    );
  }

  try {
    return await route.handler(request, env, route.params);
  } catch (error) {
    console.error(`[cleaning-schedule] ${url.pathname} でエラー: ${error?.stack ?? error}`);
    return htmlResponse(
      page({
        title: 'エラー',
        nav: false,
        body: html`<h2>エラーが発生しました</h2>
          <p class="small">${String(error?.message ?? error)}</p>
          <p class="small muted">この内容を管理者に伝えてください。</p>`
      }),
      { status: 500 }
    );
  }
}

export default {
  async fetch(request, env) {
    const response = await handle(request, env);

    // HEAD は状態とヘッダだけを返し、本文は返さない決まり。
    // Cloudflare の実行環境も落としてくれるが、明示しておかないとテストで
    // 確かめられない。死活監視が通る経路なので、実環境まかせにしない。
    if (request.method === 'HEAD') {
      return new Response(null, { status: response.status, headers: response.headers });
    }
    return response;
  },

  /**
   * 定期実行。cron は UTC 指定なので注意（wrangler.jsonc のコメント参照）。
   *   0 21 * * * = 翌日 06:00 JST … 日次処理（取得→割り当て）
   *   0 9  * * * = 当日 18:00 JST … 見張り（トークン維持・稼働監視）
   *
   * どちらも結果は runs テーブルに残るので、管理画面と /api/health から確認できる。
   * 旧版はエラーを握りつぶして誰も気づけなかったため、ここでは必ず記録する。
   */
  async scheduled(event, env, ctx) {
    const isKeepAlive = event.cron === KEEPALIVE_CRON;
    const job = isKeepAlive ? runKeepAlive : runDaily;
    const label = isKeepAlive ? '見張り' : '日次処理';

    // ★何よりも先に「呼ばれた」ことを記録する。
    //
    // 実行の行（runs）は処理が始まってから作られるので、その手前で落ちると
    // 何も残らない。すると「Cloudflare から呼ばれなかった」のか
    // 「呼ばれたがアプリが落ちた」のかを区別できない。実際にその状態になり、
    // 朝6時が動かなかったときに切り分けられなかった。
    // ここに置いておけば、以後どこで落ちても呼ばれた事実だけは必ず残る。
    await recordCronEvent(env.DB, event.cron);

    // 誰も管理画面を開かなくても、いずれ当たるようにしておく。
    // 適用は1マイグレーションごとに db.batch（＝1トランザクション）なので、
    // 途中まで適用されて壊れることはない。
    try {
      const migrated = await applyMigrations(env.DB, MIGRATIONS);
      if (migrated.applied) {
        console.log(`[cleaning-schedule] データベースを更新: ${migrated.executed.map((e) => e.name).join(', ')}`);
      }
    } catch (error) {
      console.error(`[cleaning-schedule] データベースの更新に失敗: ${error?.message ?? error}`);
      await recordNotification(
        env.DB,
        {
          kind: 'migration_failed',
          level: 'error',
          subject: 'データベースの更新に失敗しました',
          body: `${error?.message ?? error}\n\n新しく足した機能が使えない状態です。開発者に連絡してください。`
        },
        { throttleHours: 12 }
      ).catch(() => {});
    }

    try {
      const result = await job(env, { kind: 'cron' });
      console.log(`[cleaning-schedule] ${label}: ${result.ok ? '完了' : '失敗'} ${result.message ?? result.error ?? ''}`);
    } catch (error) {
      console.error(`[cleaning-schedule] ${label}が異常終了: ${error?.message ?? error}`);
      throw error;
    } finally {
      // 通知は必ず最後に送る。ジョブが失敗したときこそ届いてほしいので finally に置く。
      // Slack 側の障害でジョブを失敗扱いにはしない（記録は管理画面に残っている）。
      try {
        const notified = await flushNotifications(env);
        if (notified.sent > 0 || notified.failed > 0) {
          console.log(`[cleaning-schedule] 通知: 送信 ${notified.sent}件 / 失敗 ${notified.failed}件`);
        }
      } catch (error) {
        console.error(`[cleaning-schedule] 通知の送信に失敗: ${error?.message ?? error}`);
      }
    }
  }
};
