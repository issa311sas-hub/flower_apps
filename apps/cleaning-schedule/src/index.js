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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return jsonResponse(await checkHealth(env));
    }

    return htmlResponse(await renderPlaceholder(env));
  },

  /**
   * 定期実行。cron は UTC 指定なので注意（wrangler.jsonc のコメント参照）。
   *   0 21 * * * = 翌日 06:00 JST … 日次処理
   *   0 9  * * * = 当日 18:00 JST … 見張り
   */
  async scheduled(event, env, ctx) {
    console.log(`[cleaning-schedule] scheduled 起動: ${event.cron}（処理は未実装）`);
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

    health.d1 = {
      connected: true,
      units: units.length,
      unitOrder: units,
      staff: staff.map((s) => s.name),
      lastSuccessRunAt: run.lastSuccessAt,
      staleDays: run.staleDays
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

async function renderPlaceholder(env) {
  const health = await checkHealth(env);

  const d1Line = health.d1.connected
    ? `<p class="small">データベース: 接続OK（ユニット ${health.d1.units} 件 / 担当者 ${health.d1.staff.length} 名）</p>`
    : `<div class="banner error"><strong>データベース未接続</strong><p class="small">${escapeHtml(health.d1.error || '')}</p></div>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>清掃予定管理（準備中）</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#1f6feb">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="bar"><h1>清掃予定管理</h1><span class="badge">準備中</span></header>
<div class="wrap">
  <h2>まだ画面はありません</h2>
  <p>割り当ての計算とデータの保存はすでに動きます。スタッフ用の画面と管理画面はこれから作ります。</p>
  ${d1Line}
  <p class="small muted">動作確認: <a href="/api/health">/api/health</a></p>
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
