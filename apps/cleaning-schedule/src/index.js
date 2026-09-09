/**
 * Cloudflare Worker のエントリポイント
 *
 * ※ 現在は足場。画面・API・日次処理はこれから実装する（README のロードマップ参照）。
 *   割り当てエンジン（src/core/）とデータ層（src/db/）は実装済みで、
 *   旧 GAS 版との一致テストが通っている。
 *
 * `/api/health` は D1 の疎通確認も行うので、初回デプロイの動作確認に使える。
 */

import { listUnitNames } from './db/units.js';
import { listStaff } from './db/staff.js';
import { getRunHealth } from './db/runs.js';
import { applyMigrations, getSchemaState } from './db/migrate.js';
import { getAuthStatus } from './db/beds24Auth.js';
import { runDaily } from './jobs/dailyRun.js';
import { runKeepAlive } from './jobs/keepAlive.js';

/** 見張り役の cron（UTC 9時 = JST 18時）。wrangler.jsonc と一致させること */
const KEEPALIVE_CRON = '0 9 * * *';

// migrations/*.sql を文字列として取り込む（wrangler.jsonc の Text ルール）。
// スキーマの正は .sql のままにして、JS側に写し直さない。
import initSql from '../migrations/0001_init.sql';
import seedSql from '../migrations/0002_seed_master.sql';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return jsonResponse(await checkHealth(env));
    }

    if (url.pathname === '/setup') {
      return htmlResponse(await renderSetup(env));
    }

    return htmlResponse(await renderPlaceholder(env));
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
      // ジョブ側で記録できなかった場合の最後の砦
      console.error(`[cleaning-schedule] ${label}が異常終了: ${error?.message ?? error}`);
      throw error;
    }
  }
};

/** D1 につながっているか、初期データが入っているかを確認する */
async function checkHealth(env) {
  const health = {
    ok: true,
    stage: 'scaffold',
    note: '割り当てエンジンとデータ層は実装済み。画面と日次処理は未実装。',
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
      lastSuccessRunAt: run.lastSuccessAt,
      staleDays: run.staleDays
    };

    // Beds24 の接続状態（トークンそのものは出さない）
    const auth = await getAuthStatus(env.DB);
    health.beds24 = {
      state: auth.state,
      connected: auth.hasToken,
      lastOkAt: auth.lastOkAt,
      daysUntilExpiry: auth.daysUntilExpiry,
      lastError: auth.lastError
    };

    // 初期データ（migrations/0002）が入っていなければ、それも異常として知らせる
    if (units.length === 0 || staff.length === 0) {
      health.ok = false;
      health.d1.error = '初期データが入っていません。migrations/0002_seed_master.sql を実行してください。';
    }
  } catch (e) {
    health.ok = false;
    health.d1.error = `D1 へのクエリに失敗しました: ${e.message}`;
    health.d1.hint = 'マイグレーション（migrations/0001_init.sql）が未実行の可能性があります。';
  }

  return health;
}

/**
 * 初回セットアップ画面。
 * テーブル作成と初期データ投入を、ブラウザでこのURLを開くだけで済ませる。
 * すでに初期データが入っている場合は何もしない（既存データを壊さない）。
 */
async function renderSetup(env) {
  if (!env.DB) {
    return setupPage(
      'error',
      'データベースにつながっていません',
      `<p>D1 のバインディング（DB）が設定されていません。</p>
       <p class="small muted">wrangler.jsonc の <code>database_id</code> が正しいか確認してください。</p>`
    );
  }

  try {
    const result = await applyMigrations(env.DB, [
      { name: '0001_init.sql', sql: initSql },
      { name: '0002_seed_master.sql', sql: seedSql }
    ]);

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

    if (!result.applied) {
      return setupPage(
        'done',
        'セットアップはすでに完了しています',
        `<p>データベースの中身はそのままです。何も変更していません。</p>${summary}`
      );
    }

    const ran = result.executed.map((e) => `<li>${escapeHtml(e.name)}（${e.statements} 文）</li>`).join('');
    return setupPage(
      'ok',
      'セットアップが完了しました',
      `<p>データベースの準備ができました。</p>${summary}
       <p class="small muted">実行した内容:</p><ul class="small">${ran}</ul>`
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

  return page(
    '初回セットアップ',
    `<h2>${escapeHtml(title)}</h2>
     ${banner}
     ${body}
     <p style="margin-top:24px"><a class="btn" href="/api/health">動作確認（/api/health）を見る</a></p>`
  );
}

async function renderPlaceholder(env) {
  const health = await checkHealth(env);

  const d1Line = health.d1.connected
    ? `<p class="small">データベース: 接続OK（ユニット ${health.d1.units} 件 / 担当者 ${health.d1.staff.length} 名）</p>`
    : `<div class="banner error"><strong>データベース未接続</strong><p class="small">${escapeHtml(health.d1.error || '')}</p></div>`;

  const setupLink = health.d1.connected
    ? ''
    : '<p><a class="btn primary" href="/setup">初回セットアップを実行する</a></p>';

  return page(
    '準備中',
    `<h2>まだ画面はありません</h2>
     <p>割り当ての計算とデータの保存はすでに動きます。スタッフ用の画面と管理画面はこれから作ります。</p>
     ${d1Line}
     ${setupLink}
     <p class="small muted">動作確認: <a href="/api/health">/api/health</a></p>`
  );
}

/** 共通のHTML枠 */
function page(title, body) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>清掃予定管理 - ${escapeHtml(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#1f6feb">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="bar"><h1>清掃予定管理</h1><span class="badge">${escapeHtml(title)}</span></header>
<div class="wrap">
${body}
</div>
</body>
</html>`;
}

function jsonResponse(data) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
