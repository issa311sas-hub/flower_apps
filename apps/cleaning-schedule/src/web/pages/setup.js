/**
 * 初回セットアップ（/setup, /setup/keys）
 *
 * テーブル作成・初期データ投入・最初の管理者の作成と、「いまどこまで進んだか」の表示。
 * 運用が始まったあとは触らない画面だが、**最初の1回だけは無認証で通す必要がある**
 * （そうしないと最初の管理者を作れない）ため、入口の index.js から分けてある。
 */

import { page, htmlResponse, escapeHtml } from '../html.js';
import { requireUser } from '../auth.js';
import { listUnitMap } from '../../db/units.js';
import { applyMigrations, getSchemaState } from '../../db/migrate.js';
import { getAuthStatus } from '../../db/beds24Auth.js';
import { countUsers, createUser, listUsers } from '../../db/users.js';
import { getSetting, recordPepperFingerprint } from '../../db/settings.js';
import { MIGRATIONS } from '../../db/migrations.js';


/**
 * テーブル作成・初期データ投入・最初の管理者の作成、そして「いまどこまで進んだか」の表示。
 *
 * **空のDBに対してしか変更を加えない。** 既にデータがある場合は状態を見せるだけ。
 *
 * 管理者がすでに居る＝運用が始まっているので、そこからはログインを要求する。
 * まだ誰も居ない間だけ無認証で通す（そうしないと最初の1人が作れない）。
 */
export async function renderSetup(request, env) {
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
export function renderKeys(env) {
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
