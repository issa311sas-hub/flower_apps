/**
 * Cloudflare Worker のエントリポイント
 *
 * 画面はサーバー側でHTMLを組み立てて返す（SPAではない）。
 * 利用者は非エンジニアで端末も古いため、初回表示の速さと確実さを優先している。
 */

import { createRouter } from './router.js';
import { html, page, htmlResponse, jsonResponse, redirect, escapeHtml } from './web/html.js';
import { getCurrentUser, requireUser } from './web/auth.js';

import { listUnitNames, listUnitMap } from './db/units.js';
import { listStaff } from './db/staff.js';
import { getRunHealth, getCronHealth, recordCronEvent } from './db/runs.js';
import { applyMigrations, getSchemaState, listPendingMigrations } from './db/migrate.js';
import { getAuthStatus, STATE } from './db/beds24Auth.js';
import { countUsers, createUser, listUsers } from './db/users.js';
import { getSetting, recordPepperFingerprint, checkPepperFingerprint } from './db/settings.js';

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
import {
  showAssignments,
  showAssignment,
  updateAssignment,
  releaseAssignment,
  resetAssignment
} from './web/pages/assignments.js';
import { showTimeline } from './web/pages/timeline.js';
import { showAvailabilityOverview } from './web/pages/availability.js';
import { showReportForm, saveReportForm, undoReport } from './web/pages/report.js';
import { showReports, showReportDetail } from './web/pages/reports.js';
import { runMigrations } from './web/pages/migrate.js';
import { runNow, showRuns, showRun, ackNotification } from './web/pages/runs.js';
import { showSettings, saveSettings, testNotification } from './web/pages/settings.js';

// 適用するマイグレーションの一覧。スキーマの正は migrations/*.sql のまま
import { MIGRATIONS } from './db/migrations.js';

/** 見張り役の cron（UTC 9時 = JST 18時）。wrangler.jsonc と一致させること */
const KEEPALIVE_CRON = '0 9 * * *';

const router = createRouter();

router.get('/', async (request, env) => {
  const user = await getCurrentUser(request, env);
  if (!user) return redirect('/login');
  return redirect(user.role === 'admin' ? '/admin' : '/me');
});

router.get('/login', (request, env) => showLogin(request, env));
router.post('/login', (request, env) => doLogin(request, env));
router.post('/logout', (request, env) => doLogout(request, env));

router.get('/me', (request, env) => showMySchedule(request, env));
router.get('/me/report/:bookingId', (request, env, params) => showReportForm(request, env, params));
router.post('/me/report/:bookingId', (request, env, params) => saveReportForm(request, env, params));
router.post('/me/report/:bookingId/undo', (request, env, params) => undoReport(request, env, params));
router.get('/me/availability', (request, env) => showAvailability(request, env));
router.post('/me/availability', (request, env) => saveAvailability(request, env));
router.get('/me/password', (request, env) => showPasswordForm(request, env));
router.post('/me/password', (request, env) => changePassword(request, env));

router.get('/admin', (request, env) => showAdminHome(request, env));
router.get('/admin/staff', (request, env) => showAdminStaff(request, env));
router.post('/admin/staff', (request, env) => createStaffUser(request, env));
router.post('/admin/staff/:id/password', (request, env, params) => reissuePassword(request, env, params));
router.post('/admin/staff/:id/active', (request, env, params) => toggleStaffUser(request, env, params));

router.get('/admin/beds24', (request, env) => showBeds24(request, env));
router.post('/admin/beds24', (request, env) => connectBeds24(request, env));
router.post('/admin/beds24/discover', (request, env) => discoverUnits(request, env));
router.post('/admin/beds24/map', (request, env) => saveUnitMap(request, env));

router.get('/admin/assignments', (request, env) => showAssignments(request, env));
router.get('/admin/assignments/:bookingId', (request, env, params) => showAssignment(request, env, params));
router.post('/admin/assignments/:bookingId', (request, env, params) => updateAssignment(request, env, params));
router.post('/admin/assignments/:bookingId/auto', (request, env, params) => releaseAssignment(request, env, params));
router.post('/admin/assignments/:bookingId/reset', (request, env, params) => resetAssignment(request, env, params));

router.get('/admin/timeline', (request, env) => showTimeline(request, env));
router.get('/admin/availability', (request, env) => showAvailabilityOverview(request, env));

router.get('/admin/reports', (request, env) => showReports(request, env));
router.get('/admin/reports/:bookingId', (request, env, params) => showReportDetail(request, env, params));

router.get('/admin/settings', (request, env) => showSettings(request, env));
router.post('/admin/settings', (request, env) => saveSettings(request, env));
router.post('/admin/settings/test', (request, env) => testNotification(request, env));

router.post('/admin/migrate', (request, env) => runMigrations(request, env));

router.post('/admin/run', (request, env) => runNow(request, env));
router.get('/admin/runs', (request, env) => showRuns(request, env));
router.get('/admin/runs/:id', (request, env, params) => showRun(request, env, params));
router.post('/admin/notifications/:id/ack', (request, env, params) => ackNotification(request, env, params));

router.get('/setup', (request, env) => renderSetup(request, env));
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

// ------------------------------------------------------------------
// 初回セットアップ
// ------------------------------------------------------------------

/**
 * テーブル作成・初期データ投入・最初の管理者の作成、そして「いまどこまで進んだか」の表示。
 *
 * **空のDBに対してしか変更を加えない。** 既にデータがある場合は状態を見せるだけ。
 *
 * 管理者がすでに居る＝運用が始まっているので、そこからはログインを要求する。
 * まだ誰も居ない間だけ無認証で通す（そうしないと最初の1人が作れない）。
 */
async function renderSetup(request, env) {
  if (!env.DB) {
    return htmlResponse(
      setupPage(
        'error',
        'データベースにつながっていません',
        `<p>D1 のバインディング（DB）が設定されていません。</p>
         <p class="small muted">wrangler.jsonc の <code>database_id</code> を確認してください。</p>`
      )
    );
  }

  try {
    const before = await getSchemaState(env.DB);
    const hadUsers = before.hasSchema ? (await countUsers(env.DB)) > 0 : false;

    if (hadUsers) {
      const auth = await requireUser(request, env, { role: 'admin' });
      if (auth.response) return auth.response;
    }

    const result = await applyMigrations(env.DB, MIGRATIONS);

    // 管理者が1人もいなければ作る（ここでしか平文パスワードは表示されない）。
    //
    // ただし SESSION_PEPPER が無いうちは**作らない**。
    // 鍵が無いまま作ると、あとから鍵を登録した瞬間に、そのパスワードでは
    // 入れなくなる（照合の計算式が変わるため）。しかも画面には
    // 「パスワードが違います」としか出ず、原因にたどり着けない。
    const hasPepper = !!env.SESSION_PEPPER;

    let admin = null;
    if ((await countUsers(env.DB)) === 0 && hasPepper) {
      const iterations = await getSetting(env.DB, 'password_iterations', undefined);
      const created = await createUser(
        env.DB,
        { loginId: 'admin', displayName: '管理者', role: 'admin' },
        { pepper: env.SESSION_PEPPER, ...(iterations ? { iterations: Number(iterations) } : {}) }
      );
      admin = { loginId: 'admin', password: created.password };

      // どの鍵で作ったパスワードなのかを残す（鍵が変わったらログイン画面で警告する）
      await recordPepperFingerprint(env.DB, env.SESSION_PEPPER);
    }

    const [beds24, unitMap, users] = await Promise.all([
      getAuthStatus(env.DB),
      listUnitMap(env.DB),
      listUsers(env.DB)
    ]);

    const s = result.state;
    const steps = [
      {
        label: '秘密の鍵を Cloudflare に登録する',
        done: hasPepper && !!env.TOKEN_ENC_KEY,
        detail: `SESSION_PEPPER: ${hasPepper ? '登録済み' : '未登録'} / TOKEN_ENC_KEY: ${
          env.TOKEN_ENC_KEY ? '登録済み' : '未登録'
        }`,
        href: '/setup/keys',
        action: '鍵を作る'
      },
      {
        label: 'データベースの表を作る',
        done: s.hasSchema,
        detail: `${s.tableCount} 個`
      },
      {
        label: '初期データを入れる',
        done: s.isSeeded,
        detail: `ユニット ${s.unitCount} 件 / 担当者 ${s.staffCount} 名`
      },
      {
        label: '管理者アカウントを作る',
        done: users.length > 0 || !!admin,
        detail: admin ? 'いま作成しました' : 'ID: admin'
      },
      {
        label: 'Beds24 につなぐ',
        done: beds24.hasToken,
        detail: beds24.state,
        href: '/admin/beds24',
        action: 'Beds24 につなぐ'
      },
      {
        label: 'ユニットの対応づけを登録する',
        done: unitMap.length > 0,
        detail: `${unitMap.length} 件`,
        href: '/admin/beds24',
        action: '対応づけを登録する'
      },
      {
        label: 'スタッフのアカウントを発行する',
        done: users.some((u) => u.role === 'staff'),
        detail: `${users.filter((u) => u.role === 'staff').length} 名`,
        href: '/admin/staff',
        action: 'アカウントを発行する'
      }
    ];

    const internal =
      s.internalTables && s.internalTables.length > 0
        ? `<p class="small muted">※ ほかに ${escapeHtml(s.internalTables.join(', '))} という表もありますが、
             これは管理用のもので、このアプリのデータではありません。</p>`
        : '';

    const summary = `${checklist(steps)}
      ${nextAction(steps, admin)}
      <details class="small"><summary>テーブルの一覧を見る</summary>
        <p>${escapeHtml(s.tables.join(', '))}</p>
      </details>
      ${internal}`;

    const adminBlock = admin
      ? `<div class="banner ok">
           <strong>管理者アカウントを作成しました</strong>
           <p class="small">このパスワードは<strong>この画面にしか表示されません</strong>。いま控えてください。
           ログイン後すぐに、自分だけが分かるパスワードへの変更を求められます。</p>
           <p>ID: <strong>${escapeHtml(admin.loginId)}</strong></p>
           <div class="copy-row">
             <input id="adminpw" type="text" value="${escapeHtml(admin.password)}" readonly>
             <button type="button" class="copy" data-target="adminpw">コピー</button>
           </div>
           <p><a class="btn primary" href="/login">ログインする</a></p>
         </div>`
      : !hasPepper && users.length === 0
        ? `<div class="banner error">
             <strong>先に秘密の鍵（SESSION_PEPPER）を登録してください。</strong>
             <p class="small">鍵が登録されていないため、管理者アカウントはまだ作っていません。
             鍵が無いまま作ると、あとから鍵を登録したときに
             <strong>そのパスワードでは入れなくなります</strong>。</p>
             <p class="small">Cloudflare の画面で登録したのにここが「未登録」のままの場合は、
             <strong>ビルド用の変数</strong>に登録されている可能性があります。
             Worker の <strong>Settings → Variables and Secrets</strong>（ビルド設定の中ではない方）
             に登録し直してください。</p>
             <p><a class="btn primary" href="/setup/keys">鍵を作る</a></p>
           </div>`
        : '';

    if (!result.applied) {
      return htmlResponse(
        setupPage(
          'done',
          'セットアップはすでに完了しています',
          `<p>データベースの中身はそのままです。何も変更していません。</p>${adminBlock}${summary}`
        )
      );
    }

    const ran = result.executed.map((e) => `<li>${escapeHtml(e.name)}（${e.statements} 文）</li>`).join('');
    return htmlResponse(
      setupPage(
        'ok',
        'セットアップが完了しました',
        `<p>データベースの準備ができました。</p>${adminBlock}${summary}
         <p class="small muted">実行した内容:</p><ul class="small">${ran}</ul>`
      )
    );
  } catch (e) {
    return htmlResponse(
      setupPage(
        'error',
        'セットアップに失敗しました',
        `<p class="small">${escapeHtml(e.message)}</p>
         <p class="small muted">このメッセージをそのまま開発者に伝えてください。</p>`
      )
    );
  }
}

/** 進み具合を1画面で見せる。「次に何をすればいいか」で迷わせないため */
function checklist(steps) {
  const items = steps
    .map(
      (s) => `<li class="${s.done ? 'done' : 'todo'}">
        <span class="mark">${s.done ? '✓' : '未'}</span>
        <span>${escapeHtml(s.label)}
          ${s.detail ? `<br><span class="small muted">${escapeHtml(s.detail)}</span>` : ''}
        </span>
      </li>`
    )
    .join('');

  return `<ul class="checklist">${items}</ul>`;
}

/** 未完了のうち、いちばん最初のものだけをボタンにする */
function nextAction(steps, admin) {
  // 管理者を作った直後は、まずパスワードを控えてログインしてもらう
  if (admin) return '';

  const next = steps.find((s) => !s.done && s.href);
  if (!next) return '<p><a class="btn primary" href="/admin">管理画面へ</a></p>';

  return `<p><a class="btn primary" href="${next.href}">${escapeHtml(next.action)}</a></p>`;
}

function setupPage(status, title, body) {
  const banner =
    status === 'error'
      ? '<div class="banner error"><strong>エラー</strong></div>'
      : status === 'done'
        ? '<div class="banner">すでに完了済みです</div>'
        : '';

  return page({
    title: '初回セットアップ',
    nav: false,
    body: `<h2>${escapeHtml(title)}</h2>${banner}${body}
      <p style="margin-top:24px"><a class="btn" href="/api/health">動作確認（/api/health）を見る</a></p>`
  });
}

/**
 * Cloudflare に登録する秘密の鍵を生成して表示する。
 *
 * ブラウザの開発者ツール（コンソール）にコードを貼らせる案内は、
 * 詐欺の手口と同じ形であり、Chrome もそれを警告で止める。
 * 回避方法を教えるのではなく、アプリ側で生成する。
 *
 * - 値はリクエストのたびに新しく作り、保存も記録もしない
 * - 他人がこのURLを開いても、その人用の別の乱数が出るだけ
 * - 形式は src/integrations/crypto.js の要件（32バイトのbase64）に合わせている
 * - **すでに登録済みの鍵は作り直さない**（作り直すと復号できなくなるため）
 */
function renderKeys(env) {
  const keys = [
    {
      name: 'SESSION_PEPPER',
      note: 'ログイン情報を保護するために使います。',
      registered: !!env.SESSION_PEPPER,
      breaks: 'これを変えると、全員がログインできなくなります。'
    },
    {
      name: 'TOKEN_ENC_KEY',
      note: 'Beds24 のトークンを暗号化して保存するために使います。',
      registered: !!env.TOKEN_ENC_KEY,
      breaks: 'これを変えると、Beds24 のトークンを読めなくなり、つなぎ直しが必要になります。'
    }
  ];

  const signpost = `<div class="banner">
      <strong>この画面は「秘密の鍵を作る」専用です。</strong>
      <p class="small">初回セットアップ（テーブル作成・管理者アカウント）は
      <a href="/setup">/setup</a> です。</p>
      <p><a class="btn" href="/setup">初回セットアップ（/setup）へ</a></p>
    </div>`;

  const missing = keys.filter((k) => !k.registered);

  if (missing.length === 0) {
    return page({
      title: '鍵の生成',
      nav: false,
      body: `<h2>秘密の鍵</h2>
        <div class="banner ok"><strong>2つとも登録済みです。この画面はもう使いません。</strong></div>
        <div class="banner error">
          <strong>鍵を作り直さないでください。</strong>
          <ul class="small">
            ${keys.map((k) => `<li>${escapeHtml(k.name)}: ${escapeHtml(k.breaks)}</li>`).join('')}
          </ul>
        </div>
        ${signpost}
        <p><a class="btn" href="/login">ログイン画面へ</a></p>`
    });
  }

  const generate = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  };

  const field = (key) => `
    <label for="${key.name}">${key.name}</label>
    <p class="small muted">${escapeHtml(key.note)}</p>
    <div class="copy-row">
      <input id="${key.name}" type="text" value="${escapeHtml(generate())}" readonly spellcheck="false">
      <button type="button" class="copy" data-target="${key.name}">コピー</button>
    </div>`;

  const done = keys
    .filter((k) => k.registered)
    .map((k) => `<p class="small">${escapeHtml(k.name)} … <strong>登録済み</strong>（作り直しません）</p>`)
    .join('');

  return page({
    title: '鍵の生成',
    nav: false,
    body: `<h2>秘密の鍵</h2>
     ${signpost}
     <div class="banner">
       <strong>この画面の値は他人に見せないでください。</strong>
       <p class="small">パスワードと同じ扱いです。チャットやメールに貼らないでください。
       Cloudflare に登録し終えたら、このページを閉じてください。</p>
     </div>

     <p>Cloudflare の <strong>Settings → Variables and Secrets</strong> に、
     下の値を <strong>Secret</strong> として登録してください。</p>

     ${done}
     ${missing.map(field).join('')}

     <p class="small muted">※ 画面を再読み込みすると別の値になります。
     登録に使うのは1回だけなので、コピーしたらそのまま登録してください。</p>
     <p class="small muted">※ 一度登録すれば、作り直す必要はありません。</p>`
  });
}

/** D1 につながっているか、初期データが入っているかを確認する */
async function checkHealth(env) {
  const health = {
    ok: true,
    stage: 'm14',
    d1: { connected: false }
  };

  if (!env.DB) {
    health.ok = false;
    health.d1.error = 'D1 バインディング(DB)が設定されていません。wrangler.jsonc の database_id を確認してください。';
    return health;
  }

  try {
    const units = await listUnitNames(env.DB);
    const staff = await listStaff(env.DB);
    const run = await getRunHealth(env.DB);
    const cron = await getCronHealth(env.DB);
    const schema = await getSchemaState(env.DB);
    const auth = await getAuthStatus(env.DB);
    const fingerprint = await checkPepperFingerprint(env.DB, env.SESSION_PEPPER ?? '');
    const pending = await listPendingMigrations(env.DB, MIGRATIONS);

    health.d1 = {
      connected: true,
      units: units.length,
      unitOrder: units,
      staff: staff.map((s) => s.name),
      tableCount: schema.tableCount,
      tables: schema.tables,
      // SQLite / Cloudflare が自動で作る管理用の表。アプリのデータではない
      internalTables: schema.internalTables,
      users: await countUsers(env.DB),
      unitMap: (await listUnitMap(env.DB)).length,
      // 未適用があると、アプリが古いスキーマのまま動くことになる
      pendingMigrations: pending,
      lastSuccessRunAt: run.lastSuccessAt,
      staleDays: run.staleDays,
      // Cloudflare の cron から最後に呼ばれた時刻。
      // 「呼ばれていない」と「呼ばれたが失敗した」を切り分けるための値
      lastCronEventAt: cron.lastEventAt,
      lastCronExpression: (await getSetting(env.DB, 'last_cron_expression', '')) || null
    };

    health.beds24 = {
      state: auth.state,
      connected: auth.hasToken,
      lastOkAt: auth.lastOkAt,
      daysUntilExpiry: auth.daysUntilExpiry,
      lastError: auth.lastError
    };

    // 秘密の設定は「あるかどうか」だけ返す（値は絶対に返さない）
    health.secrets = {
      SESSION_PEPPER: !!env.SESSION_PEPPER,
      TOKEN_ENC_KEY: !!env.TOKEN_ENC_KEY,
      // 保存済みのパスワードが、いまの SESSION_PEPPER で照合できるか。
      // false なら誰もログインできない（鍵が入れ替わっている）
      pepperMatchesPasswords: fingerprint.known ? fingerprint.matches : null
    };

    // 外から見て「いま異常か」を判定する。
    // 初回セットアップ中（まだ一度も実行していない）は異常扱いにしない。
    const problems = [];

    if (units.length === 0 || staff.length === 0) {
      problems.push('初期データが入っていません。/setup を開いてください。');
      health.d1.error = '初期データが入っていません。/setup を開いてください。';
    }
    if (auth.state === STATE.NEEDS_RECONNECT) {
      problems.push('Beds24 の再接続が必要です。招待コードを発行し直してください。');
    }
    // cron から呼ばれていないことは、日次処理の失敗とは別の問題。
    // 見に行く先も直し方も違うので、別々に伝える
    if (cron.isSilent) {
      problems.push(
        `Cloudflare の自動実行から ${cron.silentDays}日間 呼ばれていません。Cron Triggers の設定を確認してください。`
      );
    }

    if (run.neverRun) {
      // 「まだ一度も」を黙って通すと、cron が登録されていないことに誰も気づけない。
      // 初期データが入っている＝セットアップは済んでいるので、猶予を置く理由がない
      problems.push('自動実行がまだ一度も成功していません。cron の設定を確認してください。');
    } else if (run.isStale) {
      problems.push(`自動実行が ${run.staleDays}日間 成功していません。`);
    }
    if (fingerprint.known && !fingerprint.matches) {
      problems.push('SESSION_PEPPER が変わっているため、誰もログインできません。');
    }
    if (pending.length > 0) {
      problems.push(
        `未適用のデータベース更新が ${pending.length}件あります。管理画面を開いて「いま更新する」を押してください。`
      );
    }

    health.problems = problems;
    health.ok = problems.length === 0;
  } catch (e) {
    health.ok = false;
    health.d1.error = `D1 へのクエリに失敗しました: ${e.message}`;
    health.d1.hint = 'マイグレーションが未実行の可能性があります。/setup を開いてください。';
  }

  return health;
}
