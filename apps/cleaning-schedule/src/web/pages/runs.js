/**
 * 実行ログと通知（管理者専用）
 *
 *   POST /admin/run                  … いま実行する（日次処理を手で回す）
 *   GET  /admin/runs                 … 実行の履歴と、未確認の警告
 *   GET  /admin/runs/:id             … 1回分の詳細（エラー全文）
 *   POST /admin/notifications/:id/ack… 警告を「確認しました」にする
 *
 * 旧 GAS 版はエラーを握りつぶし、Apps Script 側からは正常終了に見えたため、
 * 止まっていても誰も気づけなかった。ここが「気づける場所」になる。
 */

import { html, page, htmlResponse, redirect, raw, escapeHtml } from '../html.js';
import { requireUser, checkOrigin } from '../auth.js';
import { listRuns, getRun } from '../../db/runs.js';
import { listNotifications, acknowledge } from '../../db/notifications.js';
import { runDaily } from '../../jobs/dailyRun.js';
import { flushNotifications } from '../../jobs/notify.js';

const KIND_LABEL = { cron: '自動', manual: '手動', keepalive: '見張り' };

/** 実行ボタン。取得から割り当てまで通しで走らせる */
export async function runNow(request, env, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  const result = await runDaily(env, {
    kind: 'manual',
    triggeredBy: auth.user.loginId,
    now: options.now,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep
  });

  // Slack にも同じ内容を流す。手動実行でも動作確認になる
  try {
    await flushNotifications(env, { now: options.now, fetchImpl: options.fetchImpl });
  } catch {
    // 通知が送れなくても実行結果は見せる（記録はこの画面に残っている）
  }

  // 成否にかかわらず詳細へ送る（失敗したときこそ中身を見てほしい）
  return redirect(`/admin/runs/${result.runId}`);
}

export async function showRuns(request, env, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;

  const [runs, notices] = await Promise.all([listRuns(env.DB, 30), listNotifications(env.DB, 30)]);

  const runRows = runs
    .map(
      (r) => `<tr>
        <td><a href="/admin/runs/${r.id}">${escapeHtml(r.started_at ?? '')}</a></td>
        <td>${escapeHtml(KIND_LABEL[r.kind] ?? r.kind)}</td>
        <td>${resultLabel(r)}</td>
        <td>${escapeHtml(r.message ?? r.error ?? '')}</td>
      </tr>`
    )
    .join('');

  const noticeRows = notices
    .map(
      (n) => `<tr class="${n.level === 'error' ? 'unassigned' : ''}">
        <td>${escapeHtml(n.created_at)}</td>
        <td>${escapeHtml(n.subject)}</td>
        <td>${
          n.acknowledged_at
            ? '<span class="small muted">確認済み</span>'
            : `<form method="post" action="/admin/notifications/${n.id}/ack" class="inline">
                 <button type="submit" class="link small">確認しました</button>
               </form>`
        }</td>
      </tr>`
    )
    .join('');

  return htmlResponse(
    page({
      title: '実行ログ',
      user: auth.user,
      body: html`
        <h2>実行の履歴</h2>
        <div class="scroll-x"><table>
          <tr><th>日時</th><th>種別</th><th>結果</th><th>内容</th></tr>
          ${raw(runRows || '<tr><td colspan="4">まだ実行されていません。</td></tr>')}
        </table></div>

        <h2>警告</h2>
        <div class="scroll-x"><table>
          <tr><th>日時</th><th>内容</th><th></th></tr>
          ${raw(noticeRows || '<tr><td colspan="3">警告はありません。</td></tr>')}
        </table></div>
      `
    })
  );
}

export async function showRun(request, env, params, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;

  const run = await getRun(env.DB, Number(params.id));
  if (!run) return new Response('見つかりません。', { status: 404 });

  const stats =
    run.fetched === null && run.assigned === null
      ? ''
      : `<table>
           <tr><th>取得した予約</th><td>${escapeHtml(run.fetched ?? '—')}件</td></tr>
           <tr><th>割り当て</th><td>${escapeHtml(run.assigned ?? '—')}件</td></tr>
           <tr><th>確定</th><td>${escapeHtml(run.confirmed ?? '—')}件</td></tr>
           <tr><th>延期</th><td>${escapeHtml(run.deferred ?? '—')}件</td></tr>
           <tr><th>外注</th><td>${escapeHtml(run.outsourced ?? '—')}件</td></tr>
           <tr><th>未割当</th><td>${escapeHtml(run.unassigned ?? '—')}件</td></tr>
         </table>`;

  return htmlResponse(
    page({
      title: '実行の詳細',
      user: auth.user,
      body: html`
        <h2>${raw(resultLabel(run))} ${escapeHtml(KIND_LABEL[run.kind] ?? run.kind)}実行</h2>

        <table>
          <tr><th>開始</th><td>${escapeHtml(run.started_at ?? '')}</td></tr>
          <tr><th>終了</th><td>${escapeHtml(run.finished_at ?? '（実行中）')}</td></tr>
          <tr><th>実行した人</th><td>${escapeHtml(run.triggered_by ?? '自動')}</td></tr>
        </table>

        ${raw(run.message ? `<p>${escapeHtml(run.message)}</p>` : '')}
        ${raw(
          run.error
            ? `<div class="banner error"><strong>エラー</strong>
                 <p class="small">${escapeHtml(run.error).replace(/\n/g, '<br>')}</p></div>`
            : ''
        )}
        ${raw(stats)}

        <p style="margin-top:24px">
          <a class="btn" href="/admin/assignments">割り当て一覧を見る</a>
          <a class="btn" href="/admin/runs">実行ログに戻る</a>
        </p>
      `
    })
  );
}

export async function ackNotification(request, env, params, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  await acknowledge(env.DB, Number(params.id));
  return redirect('/admin/runs');
}

function resultLabel(run) {
  if (run.ok === 1) return '<span class="badge done">正常</span>';
  if (run.ok === 0) return '<span class="badge error">失敗</span>';
  return '<span class="badge">実行中</span>';
}
