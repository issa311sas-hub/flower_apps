/**
 * データベースの更新（管理者専用）
 *
 *   POST /admin/migrate … 未適用のマイグレーションを適用する
 *
 * これまでは `/setup` を開いてもらう案内にしていたが、`/setup` は
 * 管理者ログインを要求するため、ログインしていない状態で開くと
 * ログイン画面に飛ばされ「URLを開いたのに何も起きない」ことになっていた。
 * 管理者はこの画面にいる時点でログイン済みなので、ここから直接適用できるようにする。
 */

import { html, page, htmlResponse, raw, escapeHtml } from '../html.js';
import { requireUser, checkOrigin } from '../auth.js';
import { applyMigrations } from '../../db/migrate.js';
import { MIGRATIONS } from '../../db/migrations.js';

export async function runMigrations(request, env, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  let result;
  try {
    result = await applyMigrations(env.DB, MIGRATIONS);
  } catch (error) {
    return htmlResponse(
      page({
        title: 'データベースの更新',
        user: auth.user,
        body: html`
          <h2>更新に失敗しました</h2>
          <div class="banner error">
            <p class="small">${String(error?.message ?? error)}</p>
            <p class="small muted">このメッセージをそのまま開発者に伝えてください。</p>
          </div>
          <p><a class="btn" href="/admin">管理画面に戻る</a></p>
        `
      }),
      { status: 500 }
    );
  }

  const rows = result.executed
    .map((e) => `<li>${escapeHtml(e.name)}（${e.statements} 文）</li>`)
    .join('');

  return htmlResponse(
    page({
      title: 'データベースの更新',
      user: auth.user,
      body: html`
        <h2>${result.applied ? 'データベースを更新しました' : 'すでに最新です'}</h2>

        ${raw(
          result.applied
            ? `<div class="banner ok"><strong>${result.executed.length}件 の更新を適用しました。</strong></div>
               <ul class="small">${rows}</ul>`
            : '<div class="banner">未適用の更新はありませんでした。何も変更していません。</div>'
        )}

        <table>
          <tr><th>テーブル</th><td>${result.state.tableCount} 個</td></tr>
          <tr><th>ユニット</th><td>${result.state.unitCount} 件</td></tr>
          <tr><th>担当者</th><td>${result.state.staffCount} 名</td></tr>
        </table>

        <p style="margin-top:24px">
          <a class="btn primary" href="/admin">管理画面に戻る</a>
          <a class="btn" href="/api/health">動作確認（/api/health）</a>
        </p>
      `
    })
  );
}
