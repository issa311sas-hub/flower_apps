/**
 * Cloudflare Worker のエントリポイント
 *
 * 画面はサーバー側でHTMLを組み立てて返す（SPAではない）。
 * 利用者は非エンジニアで端末も古いため、初回表示の速さと確実さを優先している。
 */

import { createRouter } from './router.js';
import { html, page, htmlResponse, jsonResponse, redirect, raw, escapeHtml } from './web/html.js';
import { getCurrentUser } from './web/auth.js';

import { listUnitNames } from './db/units.js';
import { listStaff } from './db/staff.js';
import { getRunHealth } from './db/runs.js';
import { applyMigrations, getSchemaState } from './db/migrate.js';
import { getAuthStatus } from './db/beds24Auth.js';
import { countUsers, createUser } from './db/users.js';
import { getSetting } from './db/settings.js';

import { runDaily } from './jobs/dailyRun.js';
import { runKeepAlive } from './jobs/keepAlive.js';

import { showLogin, doLogin, doLogout } from './web/pages/login.js';
import {
  showMySchedule,
  completeAssignment,
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

// migrations/*.sql を文字列として取り込む（wrangler が .sql を Text として扱う）。
// スキーマの正は .sql のままにして、JS側に写し直さない。
import initSql from '../migrations/0001_init.sql';
import seedSql from '../migrations/0002_seed_master.sql';

/** 見張り役の cron（UTC 9時 = JST 18時）。wrangler.jsonc と一致させること */
const KEEPALIVE_CRON = '0 9 * * *';

const router = createRouter();

router.get('/', async (request, env) => {
  const user = await getCurrentUser(request, env);
  if (!user) return redirect('/login');
  return redirect(user.role === 'admin' ? '/admin' : '/me');
});

router.get('/login', (request) => showLogin(request));
router.post('/login', (request, env) => doLogin(request, env));
router.post('/logout', (request, env) => doLogout(request, env));

router.get('/me', (request, env) => showMySchedule(request, env));
router.post('/me/complete/:bookingId', (request, env, params) => completeAssignment(request, env, params));
router.get('/me/availability', (request, env) => showAvailability(request, env));
router.post('/me/availability', (request, env) => saveAvailability(request, env));
router.get('/me/password', (request, env) => showPasswordForm(request, env));
router.post('/me/password', (request, env) => changePassword(request, env));

router.get('/admin', (request, env) => showAdminHome(request, env));
router.get('/admin/staff', (request, env) => showAdminStaff(request, env));
router.post('/admin/staff', (request, env) => createStaffUser(request, env));
router.post('/admin/staff/:id/password', (request, env, params) => reissuePassword(request, env, params));
router.post('/admin/staff/:id/active', (request, env, params) => toggleStaffUser(request, env, params));

router.get('/setup', (request, env) => renderSetup(env).then(htmlResponse));
router.get('/setup/keys', () => htmlResponse(renderKeys()));
router.get('/api/health', async (request, env) => jsonResponse(await checkHealth(env)));

export default {
  async fetch(request, env) {
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

    try {
      const result = await job(env, { kind: 'cron' });
      console.log(`[cleaning-schedule] ${label}: ${result.ok ? '完了' : '失敗'} ${result.message ?? result.error ?? ''}`);
    } catch (error) {
      console.error(`[cleaning-schedule] ${label}が異常終了: ${error?.message ?? error}`);
      throw error;
    }
  }
};

// ------------------------------------------------------------------
// 初回セットアップ
// ------------------------------------------------------------------

/**
 * テーブル作成・初期データ投入・最初の管理者の作成。
 * **空のDBに対してしか動かない。** 既にデータがある場合は何も変更しない。
 */
async function renderSetup(env) {
  if (!env.DB) {
    return setupPage(
      'error',
      'データベースにつながっていません',
      `<p>D1 のバインディング（DB）が設定されていません。</p>
       <p class="small muted">wrangler.jsonc の <code>database_id</code> を確認してください。</p>`
    );
  }

  try {
    const result = await applyMigrations(env.DB, [
      { name: '0001_init.sql', sql: initSql },
      { name: '0002_seed_master.sql', sql: seedSql }
    ]);

    // 管理者が1人もいなければ作る（ここでしか平文パスワードは表示されない）
    let admin = null;
    if ((await countUsers(env.DB)) === 0) {
      const iterations = await getSetting(env.DB, 'password_iterations', undefined);
      const created = await createUser(
        env.DB,
        { loginId: 'admin', displayName: '管理者', role: 'admin' },
        { pepper: env.SESSION_PEPPER ?? '', ...(iterations ? { iterations: Number(iterations) } : {}) }
      );
      admin = { loginId: 'admin', password: created.password };
    }

    const s = result.state;
    const internal =
      s.internalTables && s.internalTables.length > 0
        ? `<p class="small muted">※ ほかに ${escapeHtml(s.internalTables.join(', '))} という表もありますが、
             これは SQLite / Cloudflare が自動で作る管理用のもので、このアプリのデータではありません。</p>`
        : '';

    const summary = `<table>
        <tr><th>テーブル</th><td>${s.tableCount} 個</td></tr>
        <tr><th>ユニット</th><td>${s.unitCount} 件</td></tr>
        <tr><th>担当者</th><td>${s.staffCount} 名</td></tr>
      </table>
      <details class="small"><summary>テーブルの一覧を見る</summary>
        <p>${escapeHtml(s.tables.join(', '))}</p>
      </details>
      ${internal}`;

    const adminBlock = admin
      ? `<div class="banner ok">
           <strong>管理者アカウントを作成しました</strong>
           <p class="small">このパスワードは**この画面にしか表示されません**。いま控えてください。
           ログイン後すぐに、自分だけが分かるパスワードへの変更を求められます。</p>
           <p>ID: <strong>${escapeHtml(admin.loginId)}</strong></p>
           <div class="copy-row">
             <input id="adminpw" type="text" value="${escapeHtml(admin.password)}" readonly>
             <button type="button" class="copy" data-target="adminpw">コピー</button>
           </div>
           <p><a class="btn primary" href="/login">ログインする</a></p>
         </div>`
      : '<p><a class="btn" href="/login">ログイン画面へ</a></p>';

    if (!result.applied) {
      return setupPage(
        'done',
        'セットアップはすでに完了しています',
        `<p>データベースの中身はそのままです。何も変更していません。</p>${summary}${adminBlock}`
      );
    }

    const ran = result.executed.map((e) => `<li>${escapeHtml(e.name)}（${e.statements} 文）</li>`).join('');
    return setupPage(
      'ok',
      'セットアップが完了しました',
      `<p>データベースの準備ができました。</p>${summary}
       <p class="small muted">実行した内容:</p><ul class="small">${ran}</ul>${adminBlock}`
    );
  } catch (e) {
    return setupPage(
      'error',
      'セットアップに失敗しました',
      `<p class="small">${escapeHtml(e.message)}</p>
       <p class="small muted">このメッセージをそのまま開発者に伝えてください。</p>`
    );
  }
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
 */
function renderKeys() {
  const generate = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  };

  const field = (name, note, value) => `
    <label for="${name}">${name}</label>
    <p class="small muted">${note}</p>
    <div class="copy-row">
      <input id="${name}" type="text" value="${escapeHtml(value)}" readonly spellcheck="false">
      <button type="button" class="copy" data-target="${name}">コピー</button>
    </div>`;

  return page({
    title: '鍵の生成',
    nav: false,
    body: `<h2>秘密の鍵</h2>
     <div class="banner">
       <strong>この画面の値は他人に見せないでください。</strong>
       <p class="small">パスワードと同じ扱いです。チャットやメールに貼らないでください。
       Cloudflare に登録し終えたら、このページを閉じてください。</p>
     </div>

     <p>Cloudflare の <strong>Settings → Variables and Secrets</strong> に、
     下の2つを <strong>Secret</strong> として登録してください。</p>

     ${field('SESSION_PEPPER', 'ログイン情報を保護するために使います。', generate())}
     ${field('TOKEN_ENC_KEY', 'Beds24 のトークンを暗号化して保存するために使います。', generate())}

     <p class="small muted">※ 画面を再読み込みすると別の値になります。
     登録に使うのは1回だけなので、コピーしたらそのまま登録してください。</p>
     <p class="small muted">※ 一度登録すれば、作り直す必要はありません。</p>`
  });
}

/** D1 につながっているか、初期データが入っているかを確認する */
async function checkHealth(env) {
  const health = {
    ok: true,
    stage: 'm4',
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
    const schema = await getSchemaState(env.DB);

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
      lastSuccessRunAt: run.lastSuccessAt,
      staleDays: run.staleDays
    };

    const auth = await getAuthStatus(env.DB);
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
      TOKEN_ENC_KEY: !!env.TOKEN_ENC_KEY
    };

    if (units.length === 0 || staff.length === 0) {
      health.ok = false;
      health.d1.error = '初期データが入っていません。/setup を開いてください。';
    }
  } catch (e) {
    health.ok = false;
    health.d1.error = `D1 へのクエリに失敗しました: ${e.message}`;
    health.d1.hint = 'マイグレーションが未実行の可能性があります。/setup を開いてください。';
  }

  return health;
}
