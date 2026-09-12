/**
 * 設定（管理者専用）
 *
 *   GET  /admin/settings       … Slack 通知と割り当ての設定
 *   POST /admin/settings       … 保存
 *   POST /admin/settings/test  … Slack にテスト送信する
 *
 * Slack の Webhook URL は「知っていれば誰でもそのチャンネルに投稿できる」ので、
 * Beds24 のトークンと同じ鍵で暗号化して保存し、**画面には二度と表示しない**。
 */

import { html, page, htmlResponse, redirect, raw, escapeHtml } from '../html.js';
import { requireUser, checkOrigin, readForm } from '../auth.js';
import { getSettings, setSettings, setSetting } from '../../db/settings.js';
import { recordNotification, markSent } from '../../db/notifications.js';
import { hasWebhook, saveWebhookUrl, getWebhookUrl, sendToSlack, looksLikeWebhookUrl } from '../../integrations/slack.js';
import { listActiveBookings } from '../../db/bookings.js';
import { parseItemList } from '../../db/reports.js';
import { isExcludedTitle } from '../../core/exclude.js';
import { toDisplayDate } from '../../core/dates.js';

/** 画面から変えられる数値の設定（範囲外は保存しない） */
const NUMBERS = [
  { key: 'fetch_days', label: 'Beds24 から何日先まで取得するか', min: 7, max: 365, unit: '日' },
  { key: 'outsource_window_days', label: 'この日数以内の未割当を外注に回す', min: 1, max: 60, unit: '日' },
  { key: 'max_defer_days', label: '清掃を延ばせる上限（害虫防止）', min: 0, max: 3, unit: '日' },
  { key: 'stale_run_alert_days', label: '何日成功しなければ警告するか', min: 1, max: 14, unit: '日' }
];

export async function showSettings(request, env, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;

  const params = new URL(request.url).searchParams;
  const notice = params.get('saved') === '1' ? '保存しました。' : null;

  return htmlResponse(await settingsPage(env, auth.user, { notice }));
}

async function settingsPage(env, user, view = {}) {
  const [settings, webhookSet, bookings] = await Promise.all([
    getSettings(env.DB),
    hasWebhook(env.DB),
    listActiveBookings(env.DB)
  ]);

  // ★いま登録されている語句で、実際に何が対象外になるかを見せる。
  //
  // 語句を広く取りすぎると**本物の清掃が消える**。数字だけでなく中身まで出して、
  // 保存した直後に気づけるようにする。これが今回いちばん大事な安全装置。
  const excludeWords = parseItemList(settings.exclude_title_words ?? '');
  const matched = excludeWords.length === 0
    ? []
    : bookings.filter((b) => isExcludedTitle(b.title, excludeWords));

  const excludePreview =
    excludeWords.length === 0
      ? '<p class="small muted">語句が登録されていないので、すべての予約に清掃を割り当てます。</p>'
      : matched.length === 0
        ? '<p class="small muted">いまの予約で一致するものはありません。</p>'
        : `<div class="banner">
             <strong>いまの予約のうち ${matched.length}件 が対象外になります。</strong>
             <p class="small">本物の予約が混ざっていないか確かめてください。</p>
             <ul class="small">${matched
               .slice(0, 20)
               .map(
                 (b) =>
                   `<li>${escapeHtml(b.unit)} ${escapeHtml(toDisplayDate(b.checkoutDate))}「${escapeHtml(b.title)}」</li>`
               )
               .join('')}${matched.length > 20 ? `<li>ほか ${matched.length - 20}件</li>` : ''}</ul>
           </div>`;

  const numberFields = NUMBERS.map(
    (n) => `
      <label for="${n.key}">${escapeHtml(n.label)}</label>
      <input id="${n.key}" name="${n.key}" type="number" inputmode="numeric"
             min="${n.min}" max="${n.max}" value="${escapeHtml(settings[n.key] ?? '')}">
      <p class="small muted">${n.min}〜${n.max}${n.unit}</p>`
  ).join('');

  const summaryOn = String(settings.notify_daily_summary ?? '1') === '1';

  return page({
    title: '設定',
    user,
    body: html`
      <h2>設定</h2>
      ${raw(view.notice ? `<div class="banner ok">${escapeHtml(view.notice)}</div>` : '')}
      ${raw(view.error ? `<div class="banner error"><strong>${escapeHtml(view.error)}</strong></div>` : '')}

      <h2>Slack への通知</h2>
      <div class="banner">
        <p class="small">
          自動実行が失敗した、未割当が出た、Beds24 の再接続が必要になった——
          そういうときに Slack に飛ばします。<strong>気づけないまま止まっているのが一番困る</strong>ためです。
        </p>
        <p class="small">Slack の管理画面で <strong>Incoming Webhook</strong> を作り、
        表示された <code>https://hooks.slack.com/services/...</code> を貼り付けてください。</p>
      </div>

      <p>いまの状態: <strong>${webhookSet ? '登録済み' : '未登録'}</strong></p>

      <form method="post" action="/admin/settings">
        <label for="webhook_url">Slack の Webhook URL</label>
        <input id="webhook_url" name="webhook_url" type="password" autocomplete="off"
               spellcheck="false" placeholder="${webhookSet ? '変更するときだけ入力してください' : 'https://hooks.slack.com/services/...'}">
        <p class="small muted">
          パスワードと同じ扱いです。暗号化して保存し、この画面に表示されることはありません。
          ${raw(webhookSet ? '空のまま保存すれば、いまの設定はそのままです。' : '')}
        </p>

        <label class="checkbox" for="notify_daily_summary">
          <input id="notify_daily_summary" name="notify_daily_summary" type="checkbox" value="1"
                 ${summaryOn ? 'checked' : ''}>
          正常に終わった日も、毎朝1回だけ結果を知らせる
        </label>
        <p class="small muted">
          いつも届くものが届かなければ、止まっていることに気づけます。切ると、
          異常のときしか通知が来ません。
        </p>

        <h2>完了報告の項目</h2>
        <p class="small muted">
          スタッフの報告フォームに出す項目です。<strong>1行に1つ</strong>書いてください。
          変えても、過去の報告は当時の項目名のまま残ります。
        </p>

        <label for="report_equipment">設備の確認（◯ / ✕ で答える）</label>
        <textarea id="report_equipment" name="report_equipment" rows="7">${escapeHtml(settings.report_equipment ?? '')}</textarea>

        <label for="report_services">追加サービス（なし / あり・清掃済 / あり・未清掃 で答える）</label>
        <textarea id="report_services" name="report_services" rows="4">${escapeHtml(settings.report_services ?? '')}</textarea>

        <h2>割り当ての設定</h2>
        ${raw(numberFields)}

        <h2>清掃しない予約</h2>
        <p class="small muted">
          レビュー用のダミー予約など、清掃を割り当てたくない予約の目印です。
          <strong>予約のタイトルにこの語句が含まれていれば</strong>、担当を付けません
          （画面には「対象外」として薄く出ます）。<strong>1行に1語</strong>、大文字小文字は区別しません。
        </p>
        <p class="small muted">
          管理者が手で担当を決めた予約は、語句に一致しても対象外にしません。
        </p>

        <label for="exclude_title_words">除外する語句</label>
        <textarea id="exclude_title_words" name="exclude_title_words" rows="4"
                  placeholder="テスト">${escapeHtml(settings.exclude_title_words ?? '')}</textarea>

        ${raw(excludePreview)}

        <p style="margin-top:20px"><button type="submit" class="primary">保存する</button></p>
      </form>

      ${raw(
        webhookSet
          ? `<h2>テスト送信</h2>
             <form method="post" action="/admin/settings/test">
               <p><button type="submit">Slack にテストを送る</button></p>
               <p class="small muted">Slack にメッセージが届けば設定は完了です。</p>
             </form>`
          : ''
      )}
    `
  });
}

export async function saveSettings(request, env, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  const form = await readForm(request);
  const values = {};

  for (const n of NUMBERS) {
    const value = Number(form[n.key]);
    if (Number.isInteger(value) && value >= n.min && value <= n.max) values[n.key] = value;
  }

  values.notify_daily_summary = form.notify_daily_summary ? '1' : '0';

  // 完了報告の項目（1行1項目）。改行コードを揃え、空行は落とす
  for (const key of ['report_equipment', 'report_services', 'exclude_title_words']) {
    if (form[key] === undefined) continue;
    values[key] = String(form[key])
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');
  }

  // 通知に載せるリンク先。管理者がいま開いているURLがそのまま正解なので、自動で覚える
  values.app_base_url = new URL(request.url).origin;

  await setSettings(env.DB, values);

  const webhook = String(form.webhook_url ?? '').trim();
  if (webhook) {
    if (!looksLikeWebhookUrl(webhook)) {
      return htmlResponse(
        await settingsPage(env, auth.user, {
          error: 'Slack の Webhook URL は https://hooks.slack.com/services/... の形です。貼り間違いを確認してください。'
        }),
        { status: 400 }
      );
    }

    if (!env.TOKEN_ENC_KEY) {
      return htmlResponse(
        await settingsPage(env, auth.user, { error: '秘密の鍵（TOKEN_ENC_KEY）が登録されていません。' }),
        { status: 400 }
      );
    }

    await saveWebhookUrl(env.DB, webhook, env.TOKEN_ENC_KEY);
  }

  return redirect('/admin/settings?saved=1');
}

export async function testNotification(request, env, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  const webhook = await getWebhookUrl(env.DB, env.TOKEN_ENC_KEY);
  if (!webhook) {
    return htmlResponse(await settingsPage(env, auth.user, { error: 'Webhook URL が登録されていません。' }), {
      status: 400
    });
  }

  const result = await sendToSlack(
    webhook,
    {
      level: 'info',
      subject: 'テスト送信',
      body: '清掃予定管理システムから送っています。これが届いていれば、異常のときも通知が届きます。'
    },
    { fetch: options.fetchImpl }
  );

  if (!result.ok) {
    return htmlResponse(
      await settingsPage(env, auth.user, { error: `送信できませんでした: ${result.error}` }),
      { status: 400 }
    );
  }

  // 送信できたことを記録に残す（あとから「いつ確認したか」が分かるように）。
  // ここでは既に送信済みなので、送信待ちの列に入れない（同じものが2回届かないように）
  const recorded = await recordNotification(
    env.DB,
    { kind: 'test', level: 'info', subject: 'テスト送信', body: `${auth.user.loginId} が確認しました。` },
    { throttleHours: 0 }
  );
  if (recorded.id) await markSent(env.DB, recorded.id);
  await setSetting(env.DB, 'notify_tested_at', new Date().toISOString());

  return htmlResponse(await settingsPage(env, auth.user, { notice: 'Slack に送信しました。届いているか確認してください。' }));
}
