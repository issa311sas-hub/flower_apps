/**
 * 清掃完了報告（スタッフ）
 *
 *   GET  /me/report/:bookingId … 報告フォーム
 *   POST /me/report/:bookingId … 保存して完了にする
 *
 * 旧運用でメッセージに書いてもらっていた内容をそのまま入力に置き換えたもの。
 * 物件名と清掃日は割り当てから出すので打たせない。
 *
 * 権限の担保は他のスタッフ画面と同じで、**リクエストから staff_id を受け取らない**。
 * 自分の担当でない予約は 404 にする。
 */

import { html, page, htmlResponse, redirect, raw, escapeHtml } from '../html.js';
import { requireUser, checkOrigin, readForm } from '../auth.js';
import { getStaffById } from '../../db/staff.js';
import { getAssignment, markCompleted, clearCompleted } from '../../db/assignments.js';
import { getSetting } from '../../db/settings.js';
import { recordNotification } from '../../db/notifications.js';
import { flushNotifications } from '../../jobs/notify.js';
import { toDisplayDate } from '../../core/dates.js';
import {
  CONDITIONS,
  EQUIPMENT_VALUES,
  SERVICE_VALUES,
  getReport,
  saveReport,
  deleteReport,
  parseSettlement,
  parseItemList,
  isValidCondition,
  isValidAnswer
} from '../../db/reports.js';

/** ログイン中の本人＋自分の担当かどうかを確かめる */
async function requireOwnAssignment(request, env, bookingId, options = {}) {
  const auth = await requireUser(request, env, options);
  if (auth.response) return auth;

  if (!auth.user.staffId) return { response: new Response('担当者の割り当てがありません。', { status: 403 }) };

  const staff = await getStaffById(env.DB, auth.user.staffId);
  const assignment = await getAssignment(env.DB, bookingId);

  // 自分の担当でなければ、存在するかどうかも教えない
  if (!assignment || !staff || assignment.staffName !== staff.name) {
    return { response: new Response('対象が見つかりません。', { status: 404 }) };
  }

  return { user: auth.user, staff, assignment };
}

/** 報告フォームに出す項目を settings から読む */
async function loadItems(db) {
  const [equipment, services] = await Promise.all([
    getSetting(db, 'report_equipment', ''),
    getSetting(db, 'report_services', '')
  ]);
  return {
    equipment: parseItemList(equipment),
    services: parseItemList(services)
  };
}

export async function showReportForm(request, env, params, options = {}) {
  const auth = await requireOwnAssignment(request, env, params.bookingId, options);
  if (auth.response) return auth.response;

  const [items, existing] = await Promise.all([loadItems(env.DB), getReport(env.DB, params.bookingId)]);

  return htmlResponse(reportPage(auth, items, existing));
}

function reportPage(auth, items, existing, error = null) {
  const { assignment: a } = auth;
  const answerOf = (kind, label) => existing?.answers.find((x) => x.kind === kind && x.label === label)?.value;

  const conditionButtons = CONDITIONS.map((c) => {
    const id = `cond-${c.value}`;
    const checked = (existing?.condition ?? '') === c.value ? ' checked' : '';
    return `<input type="radio" id="${id}" name="condition" value="${c.value}"${checked} required>
            <label for="${id}"><strong>${c.value}</strong> ${escapeHtml(c.label)}</label>`;
  }).join('');

  const choiceRow = (kind, label, choices, current, fallback) =>
    `<div class="answer-row">
       <div class="answer-label">${escapeHtml(label)}</div>
       <div class="pills">
         ${choices
           .map((v) => {
             const id = `${kind}-${label}-${v.value}`.replace(/[^\w-]/g, '_');
             const checked = (current ?? fallback) === v.value ? ' checked' : '';
             return `<input type="radio" id="${id}" name="${kind}_${escapeHtml(label)}" value="${v.value}"${checked}>
                     <label for="${id}">${escapeHtml(v.label)}</label>`;
           })
           .join('')}
       </div>
     </div>`;

  const equipmentRows = items.equipment
    .map((label) => choiceRow('equipment', label, EQUIPMENT_VALUES, answerOf('equipment', label), 'ok'))
    .join('');

  const serviceRows = items.services
    .map((label) => choiceRow('service', label, SERVICE_VALUES, answerOf('service', label), 'none'))
    .join('');

  return page({
    title: '完了報告',
    user: auth.user,
    body: html`
      <h2>${a.unit} の完了報告</h2>
      ${raw(error ? `<div class="banner error"><strong>${escapeHtml(error)}</strong></div>` : '')}

      <p class="small muted">清掃日 ${toDisplayDate(a.cleaningDate)}${a.title ? ` / ${a.title}` : ''}</p>

      <form method="post" action="/me/report/${encodeURIComponent(a.bookingId)}">
        <h2>使用状況</h2>
        <div class="pills stacked">${raw(conditionButtons)}</div>

        ${raw(items.equipment.length > 0 ? '<h2>設備の確認</h2>' : '')}
        ${raw(equipmentRows)}

        ${raw(items.services.length > 0 ? '<h2>追加サービス</h2>' : '')}
        ${raw(serviceRows)}

        <h2>現地精算金額</h2>
        <label for="settlement">お客さんから受け取った金額（円）</label>
        <input id="settlement" name="settlement" type="text" inputmode="numeric"
               value="${existing ? String(existing.settlementYen) : '0'}">
        <p class="small muted">
          受け取っていなければ <strong>0</strong> のままにしてください。
          この金額は、あとで給与から差し引かれます。
        </p>

        <label for="note">ひとこと（任意）</label>
        <input id="note" name="note" type="text" value="${existing?.note ?? ''}"
               placeholder="気づいたことがあれば">

        <p class="sticky-save">
          <button type="submit" class="primary">${existing ? 'この内容で直す' : '報告して完了にする'}</button>
        </p>
      </form>

      <p style="margin-top:16px"><a class="btn" href="/me">予定に戻る</a></p>
    `
  });
}

export async function saveReportForm(request, env, params, options = {}) {
  const auth = await requireOwnAssignment(request, env, params.bookingId, options);
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  const items = await loadItems(env.DB);
  const form = await readForm(request);
  const { assignment: a, staff } = auth;

  const fail = async (message) =>
    htmlResponse(reportPage(auth, items, await getReport(env.DB, params.bookingId), message), { status: 400 });

  const condition = String(form.condition ?? '');
  if (!isValidCondition(condition)) return fail('使用状況を選んでください。');

  const settlement = parseSettlement(form.settlement);
  if (!settlement.ok) return fail(settlement.error);

  // 画面に出した項目だけを受け付ける（知らない項目は無視する）
  const answers = [];
  for (const [kind, labels] of [
    ['equipment', items.equipment],
    ['service', items.services]
  ]) {
    for (const label of labels) {
      const value = String(form[`${kind}_${label}`] ?? '');
      if (!isValidAnswer(kind, value)) return fail(`「${label}」を選んでください。`);
      answers.push({ kind, label, value });
    }
  }

  await saveReport(
    env.DB,
    {
      bookingId: a.bookingId,
      cleaningDate: a.cleaningDate,
      unit: a.unit,
      staffId: staff.id,
      staffName: staff.name,
      condition,
      settlementYen: settlement.yen,
      note: String(form.note ?? '').trim().slice(0, 200)
    },
    answers,
    { userId: auth.user.id }
  );

  await markCompleted(env.DB, a.bookingId, { userId: auth.user.id });
  await notifyIfNeeded(env, { assignment: a, staff, condition, settlementYen: settlement.yen, answers });

  return redirect('/me?reported=1');
}

/**
 * 経営者がすぐ知るべきことだけを通知する。
 * どれも「あとで気づけばいい」ものではないので、まとめずに1件ずつ積む。
 */
async function notifyIfNeeded(env, { assignment, staff, condition, settlementYen, answers }) {
  const ng = answers.filter((x) => x.kind === 'equipment' && x.value === 'ng').map((x) => x.label);
  const uncleaned = answers.filter((x) => x.kind === 'service' && x.value === 'not_cleaned').map((x) => x.label);

  const lines = [];
  if (condition === 'F') lines.push('使用状況が F（次回から受け入れ拒否）です。');
  if (ng.length > 0) lines.push(`設備に不具合: ${ng.join(' / ')}`);
  if (uncleaned.length > 0) lines.push(`未清掃の追加サービス: ${uncleaned.join(' / ')}`);
  if (settlementYen > 0) lines.push(`現地精算 ${settlementYen.toLocaleString()}円 を ${staff.name} が受け取りました。`);

  if (lines.length === 0) return;

  try {
    await recordNotification(
      env.DB,
      {
        kind: 'report_alert',
        level: condition === 'F' || ng.length > 0 ? 'error' : 'warn',
        subject: `${assignment.unit} の完了報告（${toDisplayDate(assignment.cleaningDate)}）`,
        body: `${lines.join('\n')}\n\n報告者: ${staff.name}`
      },
      { throttleHours: 0 }
    );
    await flushNotifications(env);
  } catch {
    // 通知が送れなくても報告は成立させる（管理画面には残っている）
  }
}

/** 完了と報告を取り消す */
export async function undoReport(request, env, params, options = {}) {
  const auth = await requireOwnAssignment(request, env, params.bookingId, options);
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  await clearCompleted(env.DB, params.bookingId);
  await deleteReport(env.DB, params.bookingId);

  return redirect('/me');
}
