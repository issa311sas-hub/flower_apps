/**
 * 割り当て一覧（管理者専用・M5-a では読み取りのみ）
 *
 *   GET /admin/assignments                … 期間・担当者で絞って一覧する
 *   GET /admin/assignments?view=calendar  … 月ごとのカレンダーで見る
 *
 * 旧版の「割り当て結果」シートに相当する。自動実行の結果がここで見えないと
 * 正しく動いているか確認できない。
 *
 * カレンダーは「どの日に誰が入っているか」を月単位で掴むためのもの。
 * 一覧は日付順に細かく読む用、タイムライン（/admin/timeline）は
 * ユニット × 日付で棟の空きを見る用で、3つとも見たいものが違う。
 * 色分けは3つの画面でそろえてある（担当者ごと・外注・未割当）。
 */

import { html, page, htmlResponse, redirect, raw, escapeHtml } from '../html.js';
import { requireUser, checkOrigin, readForm } from '../auth.js';
import { listAssignments, getAssignment, setManual, clearManual, listHistory } from '../../db/assignments.js';
import { listStaff } from '../../db/staff.js';
import { getBooking } from '../../db/bookings.js';
import { getSetting } from '../../db/settings.js';
import {
  jstToday,
  addDays,
  toDisplayDate,
  isYmd,
  dowOf,
  monthDays,
  shiftMonth,
  monthLabel
} from '../../core/dates.js';
import { DEFAULT_PARAMS, STATUS, statusFor } from '../../core/assign.js';

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
  const month = /^\d{4}-\d{2}$/.test(requestedMonth) ? requestedMonth : today.slice(0, 7);
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
    completed: rows.filter((r) => r.completedAt).length
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
          完了 ${counts.completed}件）
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

  const heads = ['日', '月', '火', '水', '木', '金', '土']
    .map((name, i) => `<div class="cal-head ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${name}</div>`)
    .join('');

  const blanks = '<div class="cal-blank"></div>'.repeat(dowOf(days[0]));

  const cells = days
    .map((date) => {
      const items = byDate.get(date) ?? [];
      const dow = dowOf(date);
      const classes = ['cal-cell', dow === 0 ? 'sun' : dow === 6 ? 'sat' : '', date < today ? 'past' : '', date === today ? 'today' : '']
        .filter(Boolean)
        .join(' ');

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

      return `<div class="${classes}">
          <span class="cal-day">${Number(date.slice(8, 10))}</span>
          <span class="cal-jobs">${jobs}</span>
        </div>`;
    })
    .join('');

  const keepStaff = staffName ? `&staff=${encodeURIComponent(staffName)}` : '';
  const link = (m) => `/admin/assignments?view=calendar&month=${m}${keepStaff}`;

  return `<div class="calendar readonly assignments">${heads}${blanks}${cells}</div>

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
    const found = byName.get(name);
    if (!found) return '';
    if (found.kind === 'outsource') return 'outsource';
    return `staff-${Math.min(found.priority, 3)}`;
  };
}

function ymdOr(value, fallback) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') ? value : fallback;
}

// ------------------------------------------------------------------
// /admin/assignments/:bookingId … 1件の手動変更
//
// 旧版で Google カレンダーの予定を直接書き換えていた操作の置き換え。
// 保存すると is_manual=1 になり、以後の自動割り当てで動かなくなる
// （src/core/assign.js が全フェーズで手動行を除外している）。
// ------------------------------------------------------------------

export async function showAssignment(request, env, params, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;

  const view = await buildDetail(env, params.bookingId, options);
  if (!view) return new Response('この予約の割り当ては見つかりません。', { status: 404 });

  const saved = new URL(request.url).searchParams.get('saved');
  return htmlResponse(
    detailPage(auth.user, view, {
      notice:
        saved === '1'
          ? '変更しました。この行は以後の自動割り当てで動かなくなります。'
          : saved === 'auto'
            ? '固定を解除しました。担当はこのままですが、以後の自動調整の対象に戻ります。'
            : saved === 'reset'
              ? '未割当に戻しました。次の自動実行で担当が決め直されます。'
              : null
    })
  );
}

/** 画面に必要なものを一度に集める */
async function buildDetail(env, bookingId, options = {}) {
  const assignment = await getAssignment(env.DB, bookingId);
  if (!assignment) return null;

  const [booking, staff, history, maxDefer] = await Promise.all([
    getBooking(env.DB, bookingId),
    listStaff(env.DB, { includeInactive: true }),
    listHistory(env.DB, bookingId, 20),
    getSetting(env.DB, 'max_defer_days', DEFAULT_PARAMS.maxDeferDays)
  ]);

  const maxDeferDays = Number(maxDefer ?? DEFAULT_PARAMS.maxDeferDays);

  return {
    assignment,
    booking,
    staff,
    history,
    maxDeferDays,
    earliest: assignment.checkoutDate,
    latest: addDays(assignment.checkoutDate, maxDeferDays)
  };
}

function detailPage(user, view, { notice = null, error = null } = {}) {
  const { assignment: a, booking, staff, history, maxDeferDays, earliest, latest } = view;

  const choices = [
    ...staff.map((s) => s.name),
    DEFAULT_PARAMS.unassignedLabel
  ];

  const staffOptions = choices
    .map(
      (name) =>
        `<option value="${escapeHtml(name)}"${a.staffName === name ? ' selected' : ''}>${escapeHtml(name)}</option>`
    )
    .join('');

  const historyRows = history
    .map(
      (h) => `<tr>
        <td>${escapeHtml(h.changed_at)}</td>
        <td>${escapeHtml(h.changed_by === 'cron' ? '自動' : (h.changed_by ?? ''))}</td>
        <td>${escapeHtml(h.old_staff ?? '')} → ${escapeHtml(h.new_staff ?? '')}</td>
        <td>${escapeHtml(h.old_date ?? '')} → ${escapeHtml(h.new_date ?? '')}</td>
      </tr>`
    )
    .join('');

  return page({
    title: '割り当ての変更',
    user,
    body: html`
      <h2>${a.unit}（${toDisplayDate(a.checkoutDate)} 退去）</h2>
      ${raw(notice ? `<div class="banner ok">${escapeHtml(notice)}</div>` : '')}
      ${raw(error ? `<div class="banner error"><strong>${escapeHtml(error)}</strong></div>` : '')}

      <table>
        <tr><th>ユニット</th><td>${a.unit}</td></tr>
        <tr><th>退去日</th><td>${toDisplayDate(a.checkoutDate)}</td></tr>
        <tr><th>特殊要望</th><td>${a.title || '—'}</td></tr>
        <tr><th>次に泊まる人数</th><td>${a.nextGuests > 0 ? `${a.nextGuests}人` : '—'}</td></tr>
        <tr><th>今回の人数</th><td>${booking?.guests ? `${booking.guests}人` : '—'}</td></tr>
        <tr><th>いまの状態</th><td>${a.status}${a.isManual ? '（手動で固定中）' : ''}</td></tr>
        <tr><th>完了報告</th><td>${a.completedAt ? escapeHtml(a.completedAt) : 'まだ'}</td></tr>
      </table>

      <h2>変更する</h2>
      <form method="post" action="/admin/assignments/${encodeURIComponent(a.bookingId)}">
        <label for="staff_name">担当</label>
        <select id="staff_name" name="staff_name">${raw(staffOptions)}</select>

        <label for="cleaning_date">清掃日</label>
        <input id="cleaning_date" name="cleaning_date" type="date"
               value="${a.cleaningDate}" min="${earliest}" max="${latest}">
        <p class="small muted">
          ${toDisplayDate(earliest)} 〜 ${toDisplayDate(latest)} の範囲だけ指定できます。
          害虫防止のため、清掃は退去から ${maxDeferDays}日 を超えて延ばせません。
        </p>

        <p style="margin-top:20px"><button type="submit" class="primary">この内容で固定する</button></p>
      </form>

      <div class="banner">
        <p class="small">
          保存すると、この1件は<strong>以後の自動割り当てで動かなくなります</strong>。
          まわりの割り当ては次の自動実行で調整されるため、押した直後に全体が変わらないのは正常です。
        </p>
      </div>

      <h2>自動に戻す</h2>
      ${raw(
        a.isManual
          ? `<form method="post" action="/admin/assignments/${encodeURIComponent(a.bookingId)}/auto">
               <p><button type="submit">固定を解除する</button></p>
               <p class="small muted">
                 いまの担当（${escapeHtml(a.staffName)}）はそのままで、以後の自動調整の対象に戻します。
                 <strong>担当がすぐ変わるわけではありません。</strong>
               </p>
             </form>`
          : '<p class="small muted">この行は固定されていません。</p>'
      )}

      <form method="post" action="/admin/assignments/${encodeURIComponent(a.bookingId)}/reset">
        <p><button type="submit">担当を決め直す</button></p>
        <p class="small muted">
          いったん未割当に戻し、次の自動実行で改めて担当を決めます。
          出勤の入力が後から増えたときは、こちらを使ってください。
        </p>
      </form>

      <h2>変更の履歴</h2>
      <div class="scroll-x"><table>
        <tr><th>日時</th><th>変更者</th><th>担当</th><th>清掃日</th></tr>
        ${raw(historyRows || '<tr><td colspan="4">まだありません。</td></tr>')}
      </table></div>

      <p style="margin-top:24px">
        <a class="btn" href="/admin/assignments">一覧に戻る</a>
        <a class="btn" href="/admin/timeline">タイムライン</a>
      </p>
    `
  });
}

export async function updateAssignment(request, env, params, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  const view = await buildDetail(env, params.bookingId, options);
  if (!view) return new Response('この予約の割り当ては見つかりません。', { status: 404 });

  const form = await readForm(request);
  const staffName = String(form.staff_name ?? '').trim();
  const cleaningDate = String(form.cleaning_date ?? '').trim();

  const valid = new Set([...view.staff.map((s) => s.name), DEFAULT_PARAMS.unassignedLabel]);
  if (!valid.has(staffName)) {
    return htmlResponse(detailPage(auth.user, view, { error: '担当者を選んでください。' }), { status: 400 });
  }

  // 「チェックアウト日〜+N日」は害虫防止の絶対条件。手動でも破らせない
  if (!isYmd(cleaningDate) || cleaningDate < view.earliest || cleaningDate > view.latest) {
    return htmlResponse(
      detailPage(auth.user, view, {
        error: `清掃日は ${toDisplayDate(view.earliest)} 〜 ${toDisplayDate(view.latest)} の範囲で指定してください。`
      }),
      { status: 400 }
    );
  }

  // 状態は担当から決める（自動割り当てと同じ規則を使い、判定がずれないようにする）
  const outsource = view.staff.find((s) => s.kind === 'outsource');
  const status = statusFor(staffName, {
    outsourceName: outsource ? outsource.name : null,
    unassignedLabel: DEFAULT_PARAMS.unassignedLabel
  });

  await setManual(
    env.DB,
    params.bookingId,
    { staffName, cleaningDate, status },
    { userId: auth.user.id, changedBy: auth.user.loginId }
  );

  return redirect(`/admin/assignments/${encodeURIComponent(params.bookingId)}?saved=1`);
}

/**
 * 固定の解除。
 *
 * ⚠ これは「担当を決め直す」ではない。
 * 割り当てエンジンは、予約に変更がなければ前回の担当をそのまま引き継ぐ
 * （無用な入れ替えを避けるための設計。src/core/assign.js の Phase 0）。
 * つまり解除しても担当はすぐには変わらず、以後の再調整の対象に戻るだけ。
 * 決め直したい場合は resetAssignment を使う。
 */
export async function releaseAssignment(request, env, params, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  const existing = await getAssignment(env.DB, params.bookingId);
  if (!existing) return new Response('この予約の割り当ては見つかりません。', { status: 404 });

  await clearManual(env.DB, params.bookingId);
  return redirect(`/admin/assignments/${encodeURIComponent(params.bookingId)}?saved=auto`);
}

/**
 * 担当を決め直す。
 *
 * 未割当に戻したうえで固定を解除する。清掃日も退去日に戻し、
 * エンジンに延期も含めて選び直させる。
 * 「あとからスタッフの出勤入力が増えた」ときに使う操作。
 */
export async function resetAssignment(request, env, params, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  const existing = await getAssignment(env.DB, params.bookingId);
  if (!existing) return new Response('この予約の割り当ては見つかりません。', { status: 404 });

  await setManual(
    env.DB,
    params.bookingId,
    {
      staffName: DEFAULT_PARAMS.unassignedLabel,
      cleaningDate: existing.checkoutDate,
      status: STATUS.NEEDS_REVIEW
    },
    { userId: auth.user.id, changedBy: auth.user.loginId }
  );
  await clearManual(env.DB, params.bookingId);

  return redirect(`/admin/assignments/${encodeURIComponent(params.bookingId)}?saved=reset`);
}
