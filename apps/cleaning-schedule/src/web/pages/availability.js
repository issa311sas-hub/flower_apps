/**
 * 出勤入力の状況（管理者専用）
 *
 *   GET  /admin/availability            … 1ヶ月分の「誰が・どの日に・何件できるか」を表で見る
 *   GET  /admin/availability/:staffId    … 1人分を代理入力する（本人と同じ入力欄）
 *   POST /admin/availability/:staffId    … その保存
 *
 * 一覧の目的は入力状況の確認そのものではなく、**外注費の予告**である。
 * 枠が清掃件数に足りない日は、その日が外注か未割当になる。
 * 「入力が入っていない → 外注になる」という因果を、起きる前に見せる。
 *
 * 代理入力は、電話や LINE で聞いた分を管理者が入れるためのもの。
 * 入力されない日は「出勤できない」扱いで外注に回るので、
 * 本人が入れられないまま放置されると、そのまま費用になる。
 *
 * ★本人の入力を管理者が黙って上書きできる画面でもあるので、
 *   最終更新が誰なのかを必ず画面に出す。
 */

import { html, page, htmlResponse, redirect, raw, escapeHtml } from '../html.js';
import { requireUser, checkOrigin, readForm } from '../auth.js';
import {
  getCapacityMap,
  listForStaff,
  setCapacityBulk,
  clearCapacity,
  lastUpdatedFor
} from '../../db/availability.js';
import { listAvailabilityStaff, getStaffById } from '../../db/staff.js';
import { availabilityForm, parseCapacityForm } from '../availabilityForm.js';
import { listAssignments } from '../../db/assignments.js';
import { jstToday, dayNameOf, dowOf, monthDays, shiftMonth, monthLabel } from '../../core/dates.js';

export async function showAvailabilityOverview(request, env, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;

  const today = jstToday(options.now);
  const requested = new URL(request.url).searchParams.get('month') ?? '';
  const month = /^\d{4}-\d{2}$/.test(requested) ? requested : today.slice(0, 7);

  const days = monthDays(month);
  const from = days[0];
  const to = days[days.length - 1];

  const [staff, capacity, assignments] = await Promise.all([
    listAvailabilityStaff(env.DB),
    getCapacityMap(env.DB, { from, to }),
    listAssignments(env.DB, { from, to })
  ]);

  // その日に予定されている清掃の件数
  const cleaningsPerDay = {};
  for (const a of assignments) {
    cleaningsPerDay[a.cleaningDate] = (cleaningsPerDay[a.cleaningDate] ?? 0) + 1;
  }

  const rows = days
    .map((date) => {
      const dow = dowOf(date);
      const dowClass = dow === 0 ? 'sun' : dow === 6 ? 'sat' : '';
      const isPast = date < today;

      const cells = staff
        .map((s) => {
          const value = capacity[s.name]?.[date];
          // 未入力（-）と「0件」の入力は意味が違う。必ず見た目で分ける
          return value === undefined
            ? '<td class="unset">-</td>'
            : `<td>${value}</td>`;
        })
        .join('');

      const slots = staff.reduce((sum, s) => sum + (capacity[s.name]?.[date] ?? 0), 0);
      const cleanings = cleaningsPerDay[date] ?? 0;
      const balance = slots - cleanings;

      // 足りない日＝その日は外注か未割当になる。ここが一番見たい情報
      const short = balance < 0 && !isPast;

      return `<tr class="${[isPast ? 'past' : '', short ? 'short' : ''].filter(Boolean).join(' ')}">
          <th class="${dowClass}">
            <a href="/admin/timeline?from=${date}&days=7">${Number(date.slice(8, 10))}(${dayNameOf(date)})</a>
          </th>
          ${cells}
          <td>${slots}</td>
          <td>${cleanings}</td>
          <td class="${balance < 0 ? 'minus' : ''}">${balance > 0 ? `+${balance}` : balance}</td>
        </tr>`;
    })
    .join('');

  const summary = staff
    .map((s) => {
      const entered = days.filter((d) => capacity[s.name]?.[d] !== undefined);
      const total = entered.reduce((sum, d) => sum + capacity[s.name][d], 0);
      return `<tr>
          <th>${escapeHtml(s.name)}</th>
          <td>${entered.length} / ${days.length}日</td>
          <td>合計 ${total}件</td>
          <td><a class="btn small" href="/admin/availability/${s.id}?month=${month}">代わりに入力</a></td>
        </tr>`;
    })
    .join('');

  const shortDays = days.filter((date) => {
    if (date < today) return false;
    const slots = staff.reduce((sum, s) => sum + (capacity[s.name]?.[date] ?? 0), 0);
    return slots - (cleaningsPerDay[date] ?? 0) < 0;
  }).length;

  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);

  return htmlResponse(
    page({
      title: '出勤入力',
      user: auth.user,
      body: html`
        <h2>${monthLabel(month)}の出勤入力</h2>

        ${raw(
          shortDays > 0
            ? `<div class="banner error">
                 <strong>枠が足りない日が ${shortDays}日あります。</strong>
                 <p class="small">その日の清掃は外注（Rクリーン）に回るか、未割当のまま残ります。
                 下の表で赤い行を確認して、担当者に入力を頼んでください。</p>
               </div>`
            : '<div class="banner ok">今月は、これから先の日の枠が足りています。</div>'
        )}

        <table>
          <tr><th>担当者</th><th>入力済み</th><th></th><th></th></tr>
          ${raw(summary)}
        </table>

        <div class="scroll-x">
          <table class="availability">
            <tr>
              <th>日</th>
              ${raw(staff.map((s) => `<th>${escapeHtml(s.shortName || s.name)}</th>`).join(''))}
              <th>枠</th><th>清掃</th><th>過不足</th>
            </tr>
            ${raw(rows)}
          </table>
        </div>

        <p class="small muted">
          <strong>「-」は未入力</strong>で、「出勤できない（0件）」として扱われます。
          <strong>枠</strong>はその日に清掃できる件数の合計、<strong>清掃</strong>はその日の予定件数です。
          過不足がマイナスの日は、足りない分がそのまま外注になります。
          日付を押すと、その週のタイムラインが開きます。
        </p>

        <p class="small">
          <a href="/admin/availability?month=${prev}">← ${monthLabel(prev)}</a>
          &nbsp;/&nbsp;
          <a href="/admin/availability?month=${today.slice(0, 7)}">今月</a>
          &nbsp;/&nbsp;
          <a href="/admin/availability?month=${next}">${monthLabel(next)} →</a>
        </p>

        <p style="margin-top:24px">
          <a class="btn" href="/admin/timeline">タイムライン</a>
          <a class="btn" href="/admin/staff">スタッフのアカウント</a>
        </p>
      `
    })
  );
}

// ------------------------------------------------------------------
// 代理入力（1人分）
//
// 本人用の /me/availability とまったく同じ入力欄を使う（availabilityForm）。
// 違うのは「誰の分か」を URL から受け取ることだけなので、
// **管理者であることの確認を必ず先に通す。**
// ------------------------------------------------------------------

/** URL の :staffId を、出勤入力の対象になる担当者として解決する */
async function resolveStaff(env, params) {
  const id = Number(params.staffId);
  if (!Number.isInteger(id)) return null;

  const staff = await getStaffById(env.DB, id);
  if (!staff) return null;

  // Rクリーン（外注）は出勤入力を使わない。入れられると割り当ての前提が狂う
  if (!staff.usesAvailability) return null;

  return staff;
}

export async function showStaffAvailability(request, env, params, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;

  const staff = await resolveStaff(env, params);
  if (!staff) return new Response('担当者が見つかりません。', { status: 404 });

  const url = new URL(request.url);
  const today = jstToday(options.now);
  const requested = url.searchParams.get('month') ?? '';
  const month = /^\d{4}-\d{2}$/.test(requested) ? requested : today.slice(0, 7);
  const saved = url.searchParams.get('saved') === '1';
  const view = url.searchParams.get('view') === 'list' ? 'list' : 'calendar';

  const days = monthDays(month);
  const range = { from: days[0], to: days[days.length - 1] };

  const [current, last] = await Promise.all([
    listForStaff(env.DB, staff.id, range),
    lastUpdatedFor(env.DB, staff.id, range)
  ]);

  const missing = days.filter((d) => d >= today && current[d] === undefined).length;
  const base = `/admin/availability/${staff.id}?month=${month}`;

  return htmlResponse(
    page({
      title: '代理入力',
      user: auth.user,
      body: html`
        <h2>${escapeHtml(staff.name)} の出勤（${monthLabel(month)}）</h2>
        ${raw(saved ? '<div class="banner ok">保存しました。</div>' : '')}

        <div class="banner">
          <strong>本人の代わりに入力しています。</strong>
          <p class="small">
            保存すると、本人の出勤入力の画面にもこの内容が出ます。
            入力がない日は「出勤できない（0件）」として扱われ、その分は外注に回ります。
            ${raw(missing > 0 ? `この月はあと <strong>${missing}日</strong> 未入力です。` : 'この月はすべて入力済みです。')}
          </p>
          ${raw(
            last
              ? `<p class="small muted">最終更新: ${escapeHtml(last.at)}
                   ${last.byName ? `（${escapeHtml(last.byName)}${last.byRole === 'admin' ? '・管理者' : ''}）` : ''}</p>`
              : '<p class="small muted">この月はまだ一度も入力されていません。</p>'
          )}
        </div>

        <p class="views small">
          ${raw(
            view === 'calendar'
              ? `<strong>カレンダー</strong> / <a href="${base}&view=list">一覧入力</a>`
              : `<a href="${base}">カレンダー</a> / <strong>一覧入力</strong>`
          )}
        </p>

        ${raw(
          availabilityForm({
            days,
            current,
            today,
            month,
            view,
            action: `/admin/availability/${staff.id}`
          })
        )}

        <p class="small">
          <a href="/admin/availability/${staff.id}?month=${shiftMonth(month, -1)}${view === 'list' ? '&view=list' : ''}">← ${monthLabel(shiftMonth(month, -1))}</a>
          &nbsp;/&nbsp;
          <a href="/admin/availability/${staff.id}?month=${shiftMonth(month, 1)}${view === 'list' ? '&view=list' : ''}">${monthLabel(shiftMonth(month, 1))} →</a>
        </p>

        <p style="margin-top:24px"><a class="btn" href="/admin/availability?month=${month}">出勤の一覧に戻る</a></p>
      `
    })
  );
}

export async function saveStaffAvailability(request, env, params, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  const staff = await resolveStaff(env, params);
  if (!staff) return new Response('担当者が見つかりません。', { status: 404 });

  const form = await readForm(request);
  const today = jstToday(options.now);
  const { month, view, entries, clears } = parseCapacityForm(form, today);

  // updatedBy は**入力した管理者**を残す。本人が入れたものと区別できなくなるため
  await setCapacityBulk(env.DB, staff.id, entries, { updatedBy: auth.user.id });
  for (const date of clears) await clearCapacity(env.DB, staff.id, date);

  const viewQuery = view === 'list' ? '&view=list' : '';
  return redirect(`/admin/availability/${staff.id}?month=${month}&saved=1${viewQuery}`);
}
