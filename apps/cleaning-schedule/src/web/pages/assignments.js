/**
 * 割り当て一覧（管理者専用・M5-a では読み取りのみ）
 *
 *   GET /admin/assignments                … 期間・担当者で絞って一覧する
 *   GET /admin/assignments?view=calendar  … 月ごとのカレンダーで見る
 *
 * 旧版の「割り当て結果」シートに相当する。自動実行の結果がここで見えないと
 * 正しく動いているか確認できない。
 *
 * 1件ずつの手動変更は assignment.js（単数）に分けてある。
 * こちらは「読む」画面、あちらは「変える」画面。
 *
 * カレンダーは「どの日に誰が入っているか」を月単位で掴むためのもの。
 * 一覧は日付順に細かく読む用、タイムライン（/admin/timeline）は
 * ユニット × 日付で棟の空きを見る用で、3つとも見たいものが違う。
 * 色分けは3つの画面でそろえてある（担当者ごと・外注・未割当）。
 */

import { html, page, htmlResponse, raw, escapeHtml } from '../html.js';
import { requireUser } from '../auth.js';
import { listAssignments } from '../../db/assignments.js';
import { listStaff } from '../../db/staff.js';
import { jstToday, addDays, toDisplayDate, isYmd, monthDays, shiftMonth, monthLabel, monthOr } from '../../core/dates.js';
import { calendarGrid, cellClasses } from '../calendar.js';
import { DEFAULT_PARAMS } from '../../core/assign.js';
import { EXCLUDED_LABEL } from '../../core/exclude.js';

const DEFAULT_RANGE_DAYS = 30;

export async function showAssignments(request, env, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;

  const params = new URL(request.url).searchParams;
  const today = jstToday(options.now);
  const view = params.get('view') === 'calendar' ? 'calendar' : 'list';
  const staffName = params.get('staff') || null;

  // カレンダーは月単位、一覧は開始日〜終了日。見たい単位が違うので期間の決め方も変える
  const requestedMonth = params.get('month') ?? '';
  const month = monthOr(requestedMonth, today);
  const days = monthDays(month);

  const from = view === 'calendar' ? days[0] : ymdOr(params.get('from'), today);
  const to = view === 'calendar' ? days[days.length - 1] : ymdOr(params.get('to'), addDays(from, DEFAULT_RANGE_DAYS));

  const [rows, staff] = await Promise.all([
    listAssignments(env.DB, { from, to, staffName }),
    listStaff(env.DB, { includeInactive: true })
  ]);

  const classOf = rowClassifier(staff);

  const counts = {
    total: rows.length,
    unassigned: rows.filter((r) => r.staffName === DEFAULT_PARAMS.unassignedLabel).length,
    outsourced: rows.filter((r) => classOf(r.staffName) === 'outsource').length,
    completed: rows.filter((r) => r.completedAt).length,
    excluded: rows.filter((r) => r.staffName === EXCLUDED_LABEL).length
  };

  const staffOptions = ['', ...staff.map((s) => s.name), DEFAULT_PARAMS.unassignedLabel]
    .map(
      (name) =>
        `<option value="${escapeHtml(name)}"${staffName === name ? ' selected' : ''}>${
          name === '' ? '（全員）' : escapeHtml(name)
        }</option>`
    )
    .join('');

  const ctx = { rows, staff, classOf, today, month, days, staffName };
  const keepStaff = staffName ? `&staff=${encodeURIComponent(staffName)}` : '';

  return htmlResponse(
    page({
      title: '割り当て',
      user: auth.user,
      body: html`
        <h2>清掃の割り当て</h2>

        <p class="views small">
          ${raw(
            view === 'list'
              ? `<strong>一覧</strong> / <a href="/admin/assignments?view=calendar&month=${month}${keepStaff}">カレンダー</a>`
              : `<a href="/admin/assignments${staffName ? `?staff=${encodeURIComponent(staffName)}` : ''}">一覧</a> / <strong>カレンダー</strong>`
          )}
        </p>

        ${raw(
          view === 'calendar'
            ? `<form method="get" action="/admin/assignments" class="filters">
                 <input type="hidden" name="view" value="calendar">
                 <div>
                   <label for="month">月</label>
                   <input id="month" name="month" type="month" value="${month}">
                 </div>
                 <div>
                   <label for="staff">担当</label>
                   <select id="staff" name="staff">${staffOptions}</select>
                 </div>
                 <div><button type="submit">絞り込む</button></div>
               </form>`
            : `<form method="get" action="/admin/assignments" class="filters">
                 <div>
                   <label for="from">開始</label>
                   <input id="from" name="from" type="date" value="${from}">
                 </div>
                 <div>
                   <label for="to">終了</label>
                   <input id="to" name="to" type="date" value="${to}">
                 </div>
                 <div>
                   <label for="staff">担当</label>
                   <select id="staff" name="staff">${staffOptions}</select>
                 </div>
                 <div><button type="submit">絞り込む</button></div>
               </form>`
        )}

        <p class="small">
          ${counts.total}件（うち
          <strong>未割当 ${counts.unassigned}件</strong> /
          外注 ${counts.outsourced}件 /
          完了 ${counts.completed}件${counts.excluded > 0 ? ` / 対象外 ${counts.excluded}件` : ''}）
        </p>
        ${raw(
          counts.unassigned > 0
            ? '<div class="banner"><strong>担当が決まっていない清掃があります。</strong><p class="small">スタッフの出勤入力が足りていない可能性があります。</p></div>'
            : ''
        )}

        ${raw(view === 'calendar' ? assignmentsCalendar(ctx) : assignmentsList(ctx))}

        <p style="margin-top:24px"><a class="btn" href="/admin/timeline">タイムラインで見る</a></p>
      `
    })
  );
}

/** 日付順の表。1件ずつ細かく読む用 */
function assignmentsList({ rows, classOf }) {
  const body = rows
    .map(
      (r) => `<tr class="${classOf(r.staffName)}">
        <td>${escapeHtml(toDisplayDate(r.cleaningDate))}</td>
        <td>${escapeHtml(r.unit)}</td>
        <td>${escapeHtml(r.staffName)}${r.isManual ? '<br><span class="small">手動</span>' : ''}</td>
        <td>${escapeHtml(r.status)}</td>
        <td>${r.cleaningDate === r.checkoutDate ? '' : escapeHtml(`${toDisplayDate(r.checkoutDate)}発`)}</td>
        <td>${r.nextGuests > 0 ? `${r.nextGuests}人` : ''}</td>
        <td>${r.completedAt ? '済' : ''}</td>
        <td>${escapeHtml(r.title ?? '')}</td>
        <td><a href="/admin/assignments/${encodeURIComponent(r.bookingId)}">変更</a></td>
      </tr>`
    )
    .join('');

  return `<div class="scroll-x"><table>
      <tr><th>清掃日</th><th>ユニット</th><th>担当</th><th>状態</th><th>退去</th><th>次</th><th>完了</th><th>特殊要望</th><th></th></tr>
      ${body || '<tr><td colspan="9">この期間の予定はありません。</td></tr>'}
    </table></div>`;
}

/**
 * 月表示。
 *
 * 一覧では「その月に誰がどれだけ入っているか」が読み取れないので、月の形で並べる。
 * マスの中の1件ずつが変更画面への入口になっている（一覧の「変更」と同じ先）。
 *
 * 色は担当者ごと。タイムラインと一覧と**同じ規則**にそろえてあるので、
 * 画面を行き来しても同じ色が同じ意味を指す。
 */
function assignmentsCalendar({ rows, staff, today, month, days, staffName }) {
  const byName = new Map(staff.map((s) => [s.name, s]));

  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.cleaningDate)) byDate.set(r.cleaningDate, []);
    byDate.get(r.cleaningDate).push(r);
  }

  const grid = calendarGrid(
    days,
    (date) => {
      const items = byDate.get(date) ?? [];

      const jobs = items
        .map((a) => {
          const info = byName.get(a.staffName);
          const label = info?.shortName || a.staffName;
          return `<a class="cal-job ${jobClass(a, byName)}"
                     href="/admin/assignments/${encodeURIComponent(a.bookingId)}"
                     title="${escapeHtml(`${a.unit} / ${a.staffName} / ${a.status}`)}"
                  >${escapeHtml(a.unit)} <span class="who">${escapeHtml(label)}</span>${
                    a.completedAt ? '<span class="done-mark">✓</span>' : ''
                  }${a.isManual ? '<span class="manual-mark">固</span>' : ''}</a>`;
        })
        .join('');

      return `<div class="${cellClasses(date, today)}">
          <span class="cal-day">${Number(date.slice(8, 10))}</span>
          <span class="cal-jobs">${jobs}</span>
        </div>`;
    },
    { extraClass: 'readonly assignments' }
  );

  const keepStaff = staffName ? `&staff=${encodeURIComponent(staffName)}` : '';
  const link = (m) => `/admin/assignments?view=calendar&month=${m}${keepStaff}`;

  return `${grid}

    <p class="small muted">
      マスの中を押すと、その清掃の担当を変えられます。
      「✓」は完了報告が済んだもの、「固」は手動で固定したものです。
      ${staffName ? `いまは <strong>${escapeHtml(staffName)}</strong> だけを表示しています。` : ''}
    </p>

    <p class="small">
      <a href="${link(shiftMonth(month, -1))}">← ${monthLabel(shiftMonth(month, -1))}</a>
      &nbsp;/&nbsp;
      <a href="${link(today.slice(0, 7))}">今月</a>
      &nbsp;/&nbsp;
      <a href="${link(shiftMonth(month, 1))}">${monthLabel(shiftMonth(month, 1))} →</a>
    </p>`;
}

/** カレンダーの1件ごとの色。タイムラインの cellClass と同じ規則 */
function jobClass(assignment, byName) {
  if (assignment.staffName === DEFAULT_PARAMS.unassignedLabel) return 'job-unassigned';
  if (assignment.staffName === EXCLUDED_LABEL) return 'job-excluded';

  const staff = byName.get(assignment.staffName);
  if (!staff) return '';
  if (staff.kind === 'outsource') return 'job-outsource';
  return `job-staff-${Math.min(staff.priority, 3)}`;
}

/** 担当者名から行の色分けを決める（旧版のシート色分けの置き換え） */
function rowClassifier(staff) {
  const byName = new Map(staff.map((s) => [s.name, s]));

  return (name) => {
    if (name === DEFAULT_PARAMS.unassignedLabel) return 'unassigned';
    // ダミー予約。担当は付かないが、消さずに薄く出す
    if (name === EXCLUDED_LABEL) return 'excluded';
    const found = byName.get(name);
    if (!found) return '';
    if (found.kind === 'outsource') return 'outsource';
    return `staff-${Math.min(found.priority, 3)}`;
  };
}

function ymdOr(value, fallback) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') ? value : fallback;
}
