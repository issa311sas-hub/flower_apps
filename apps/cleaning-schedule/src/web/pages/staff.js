/**
 * スタッフ用の画面（3つ）
 *
 *   /me              … 自分の清掃予定（完了報告つき）
 *   /me/availability … 出勤可能件数の入力  ★この移行の成否を決める画面
 *   /me/password     … パスワード変更
 *
 * どの処理も**リクエストから staff_id を受け取らない**。必ずログイン中の本人から引く。
 */

import { html, page, htmlResponse, redirect, raw, escapeHtml } from '../html.js';
import { requireUser, checkOrigin, readForm } from '../auth.js';
import { jstToday, addDays, dayNameOf, dowOf, toDisplayDate, monthDays, shiftMonth, monthLabel } from '../../core/dates.js';
import { listAssignments, getAssignment } from '../../db/assignments.js';
import { sumSettlementsFor } from '../../db/reports.js';
import { listForStaff, setCapacityBulk, clearCapacity } from '../../db/availability.js';
import { getStaffById } from '../../db/staff.js';
import { setPassword } from '../../db/users.js';
import { getSetting } from '../../db/settings.js';

const SCHEDULE_DAYS = 14;

/** ログイン中のユーザーに紐づく担当者を取り出す */
async function requireStaff(request, env, options = {}) {
  const auth = await requireUser(request, env, options);
  if (auth.response) return auth;

  if (!auth.user.staffId) {
    return {
      response: htmlResponse(
        page({
          title: '予定',
          user: auth.user,
          body: html`<div class="banner">
            <strong>担当者の割り当てがありません</strong>
            <p class="small">このアカウントは清掃の担当者に紐づいていません。管理者に連絡してください。</p>
          </div>`
        })
      )
    };
  }

  const staff = await getStaffById(env.DB, auth.user.staffId);
  return { user: auth.user, staff };
}

// ------------------------------------------------------------------
// /me … 自分の予定
// ------------------------------------------------------------------
export async function showMySchedule(request, env, options = {}) {
  const auth = await requireStaff(request, env, options);
  if (auth.response) return auth.response;

  const url = new URL(request.url);
  const today = jstToday(options.now);
  const reported = url.searchParams.get('reported') === '1';

  // 既定は日付順のリスト。「清掃おわりました」を押すのは毎日の作業なので、
  // 押せる画面を最初に出す。カレンダーは月全体を見渡すためのもの（表示だけ）
  const view = url.searchParams.get('view') === 'calendar' ? 'calendar' : 'list';
  const requested = url.searchParams.get('month') ?? '';
  const month = /^\d{4}-\d{2}$/.test(requested) ? requested : today.slice(0, 7);

  const days = monthDays(month);
  const range =
    view === 'calendar'
      ? { from: days[0], to: days[days.length - 1] }
      : { from: today, to: addDays(today, SCHEDULE_DAYS) };

  const rows = await listAssignments(env.DB, { ...range, staffName: auth.staff.name });

  // 給与から差し引かれる額なので、本人も確認できるようにする（表示中の月ではなく今月）
  const settlement = await sumSettlementsFor(env.DB, auth.staff.id, {
    from: `${today.slice(0, 7)}-01`,
    to: `${today.slice(0, 7)}-31`
  });

  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.cleaningDate)) byDate.set(row.cleaningDate, []);
    byDate.get(row.cleaningDate).push(row);
  }

  const ctx = { today, month, days, byDate };

  return htmlResponse(
    page({
      title: '予定',
      user: auth.user,
      body: html`
        <h2>${auth.staff.name}の予定</h2>
        ${raw(reported ? '<div class="banner ok">報告しました。おつかれさまでした。</div>' : '')}
        ${raw(
          settlement.total > 0
            ? `<div class="banner">
                 <strong>今月の現地精算 ${settlement.total.toLocaleString()}円</strong>
                 <p class="small">お客さんから受け取った分の合計です。あとで給与から差し引かれます。</p>
               </div>`
            : ''
        )}

        <p class="views small">
          ${raw(
            view === 'list'
              ? `<strong>これからの予定</strong> / <a href="/me?view=calendar">カレンダー</a>`
              : `<a href="/me">これからの予定</a> / <strong>カレンダー</strong>`
          )}
        </p>

        ${raw(view === 'calendar' ? scheduleCalendar(ctx) : scheduleList(ctx))}
      `
    })
  );
}

/** 日付順のカード。ここから完了報告に進む */
function scheduleList({ today, byDate }) {
  const todayCount = (byDate.get(today) ?? []).length;

  const sections = [...byDate.entries()].map(([date, items]) => {
    const badge =
      date === today
        ? '<span class="badge today">今日</span>'
        : date === addDays(today, 1)
          ? '<span class="badge">明日</span>'
          : '';
    const dow = dowOf(date);
    const dowClass = dow === 0 ? 'sun' : dow === 6 ? 'sat' : '';

    const cards = items
      .map(
        (a) => `<div class="card">
          <div class="unit">${escapeHtml(a.unit)}</div>
          ${a.title ? `<div class="note">${escapeHtml(a.title)}</div>` : ''}
          ${a.nextGuests > 0 ? `<div class="note">次 ${a.nextGuests}人</div>` : ''}
          ${
            a.completedAt
              ? `<p><span class="badge done">完了</span>
                 <a class="link small" href="/me/report/${encodeURIComponent(a.bookingId)}">報告を直す</a>
                 <form method="post" action="/me/report/${encodeURIComponent(a.bookingId)}/undo" class="inline"
                       data-confirm="完了報告を取り消します。入力した現地精算金額も消えます。よろしいですか？">
                   <button type="submit" class="link small">取り消す</button>
                 </form></p>`
              : `<p><a class="btn primary" href="/me/report/${encodeURIComponent(a.bookingId)}">清掃おわりました</a></p>`
          }
        </div>`
      )
      .join('');

    return `<div class="day"><span class="${dowClass}">${escapeHtml(toDisplayDate(date))}</span> ${badge}</div>${cards}`;
  });

  return `<p class="small muted">
      ${todayCount > 0 ? `今日は ${todayCount}件です。` : '今日の予定はありません。'}
      （${toDisplayDate(today)} から ${SCHEDULE_DAYS}日分）
    </p>
    ${sections.length > 0 ? sections.join('') : '<div class="card"><p>予定はありません。</p></div>'}`;
}

/**
 * 月表示（見るだけ）。
 *
 * 旧運用では Google カレンダーで予定を確認してもらっていたので、
 * 同じ見え方を用意する。**押せるボタンは置かない**（完了報告はリスト側から）。
 * どの日に何棟あるかを月単位で把握するためのもの。
 */
function scheduleCalendar({ today, month, days, byDate }) {
  const heads = DOW_HEADS.map(
    (name, i) => `<div class="cal-head ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${name}</div>`
  ).join('');

  const blanks = '<div class="cal-blank"></div>'.repeat(dowOf(days[0]));

  const cells = days
    .map((date) => {
      const items = byDate.get(date) ?? [];
      const dow = dowOf(date);
      const classes = [
        'cal-cell',
        dow === 0 ? 'sun' : dow === 6 ? 'sat' : '',
        date < today ? 'past' : '',
        date === today ? 'today' : '',
        items.length > 0 ? 'has-jobs' : ''
      ]
        .filter(Boolean)
        .join(' ');

      const jobs = items
        .map(
          (a) =>
            `<span class="cal-job${a.completedAt ? ' done' : ''}">${escapeHtml(a.unit)}${
              a.completedAt ? ' ✓' : ''
            }</span>`
        )
        .join('');

      return `<div class="${classes}">
          <span class="cal-day">${Number(date.slice(8, 10))}</span>
          <span class="cal-jobs">${jobs}</span>
        </div>`;
    })
    .join('');

  const total = [...byDate.values()].reduce((sum, items) => sum + items.length, 0);
  const doneCount = [...byDate.values()].flat().filter((a) => a.completedAt).length;

  return `<p class="small muted">${monthLabel(month)}は ${total}件（完了 ${doneCount}件）です。</p>

    <div class="calendar readonly">${heads}${blanks}${cells}</div>

    <p class="small muted">✓ は完了報告が済んだものです。清掃おわりましたのボタンは
      <a href="/me">これからの予定</a> にあります。</p>

    <p class="small">
      <a href="/me?view=calendar&month=${shiftMonth(month, -1)}">← ${monthLabel(shiftMonth(month, -1))}</a>
      &nbsp;/&nbsp;
      <a href="/me?view=calendar&month=${today.slice(0, 7)}">今月</a>
      &nbsp;/&nbsp;
      <a href="/me?view=calendar&month=${shiftMonth(month, 1)}">${monthLabel(shiftMonth(month, 1))} →</a>
    </p>`;
}

// ------------------------------------------------------------------
// /me/availability … 出勤可能件数の入力
// ------------------------------------------------------------------
const CAPACITY_CHOICES = [0, 1, 2, 3, 4, 5];

/** 「未入力に戻す」を表す値。0件（出勤できない）とは意味が違う */
const CLEAR_VALUE = -1;

const DOW_HEADS = ['日', '月', '火', '水', '木', '金', '土'];

export async function showAvailability(request, env, options = {}) {
  const auth = await requireStaff(request, env, options);
  if (auth.response) return auth.response;

  const url = new URL(request.url);
  const today = jstToday(options.now);
  const month = url.searchParams.get('month') ?? today.slice(0, 7);
  const saved = url.searchParams.get('saved') === '1';
  // 既定はカレンダー。一覧入力は ?view=list で開ける
  const view = url.searchParams.get('view') === 'list' ? 'list' : 'calendar';

  const days = monthDays(month);
  const current = await listForStaff(env.DB, auth.staff.id, {
    from: days[0],
    to: days[days.length - 1]
  });

  const missing = days.filter((d) => d >= today && current[d] === undefined).length;
  const ctx = { days, current, today, month };

  return htmlResponse(
    page({
      title: '出勤入力',
      user: auth.user,
      body: html`
        <h2>${monthLabel(month)}の出勤</h2>
        ${raw(saved ? '<div class="banner ok">保存しました。</div>' : '')}

        <p class="views small">
          ${raw(
            view === 'calendar'
              ? `<strong>カレンダー</strong> / <a href="/me/availability?month=${month}&view=list">一覧入力</a>`
              : `<a href="/me/availability?month=${month}">カレンダー</a> / <strong>一覧入力</strong>`
          )}
        </p>

        <div class="banner">
          <strong>入力がない日は「出勤できない（0件）」として扱われます。</strong>
          <p class="small">その日に清掃できる件数を選んでください。
          ${raw(
            missing > 0
              ? `この月はあと <strong>${missing}日</strong> 未入力です。`
              : 'この月はすべて入力済みです。'
          )}</p>
        </div>

        <form method="post" action="/me/availability">
          <input type="hidden" name="month" value="${month}">
          <input type="hidden" name="view" value="${view}">

          <div class="presets small">
            まとめて入力:
            <button type="button" class="bulk" data-days="weekday" data-value="3">平日すべて3件</button>
            <button type="button" class="bulk" data-days="all" data-value="0">すべて0件</button>
          </div>

          ${raw(view === 'calendar' ? calendarView(ctx) : listView(ctx))}

          <p class="sticky-save"><button type="submit" class="primary">この月をまとめて保存</button></p>
        </form>

        <p class="small">
          <a href="/me/availability?month=${shiftMonth(month, -1)}${view === 'list' ? '&view=list' : ''}">← ${monthLabel(shiftMonth(month, -1))}</a>
          &nbsp;/&nbsp;
          <a href="/me/availability?month=${shiftMonth(month, 1)}${view === 'list' ? '&view=list' : ''}">${monthLabel(shiftMonth(month, 1))} →</a>
        </p>
      `
    })
  );
}

/**
 * 1日分のラジオボタン。
 *
 * カレンダーでも一覧でも**まったく同じ入力欄**を使う。
 * 送信されるのは `cap_YYYY-MM-DD` だけなので、保存処理は1つで済む。
 */
function radiosFor(date, value, isPast, { hidden = false } = {}) {
  const choices = hidden ? [...CAPACITY_CHOICES, CLEAR_VALUE] : CAPACITY_CHOICES;

  return choices
    .map((n) => {
      const id = `d${date}-${n}`;
      const label = n === CLEAR_VALUE ? '消す' : String(n);
      return `<input type="radio" id="${id}" name="cap_${date}" value="${n}"${
        value === n ? ' checked' : ''
      }${isPast ? ' disabled' : ''}>${hidden ? '' : `<label for="${id}">${label}</label>`}`;
    })
    .join('');
}

function dayClass(date, value, today) {
  const dow = dowOf(date);
  return {
    dowClass: dow === 0 ? 'sun' : dow === 6 ? 'sat' : '',
    isPast: date < today,
    isUnset: value === undefined && date >= today
  };
}

/**
 * カレンダー入力（既定）。
 *
 * マスを押すと、下のピッカーで件数を選ぶ。ピッカーはマスの中の
 * ラジオボタンを選ぶだけなので、保存の仕組みは一覧入力と同一。
 * ピッカーの操作には JavaScript が要るため、動かない端末向けに
 * 一覧入力への案内を出す（一覧入力は JS なしで完全に動く）。
 */
function calendarView({ days, current, today }) {
  const heads = DOW_HEADS.map(
    (name, i) => `<div class="cal-head ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${name}</div>`
  ).join('');

  // 月初の曜日まで空セルで埋める（1日が水曜なら先頭に3つ）
  const blanks = '<div class="cal-blank"></div>'.repeat(dowOf(days[0]));

  const cells = days
    .map((date) => {
      const value = current[date];
      const { dowClass, isPast, isUnset } = dayClass(date, value, today);
      const classes = ['cal-cell', dowClass, isPast ? 'past' : '', isUnset ? 'unset' : '', date === today ? 'today' : '']
        .filter(Boolean)
        .join(' ');

      return `<div class="${classes}" data-day="${date}"${isPast ? ' data-past="1"' : ''}${
        dowClass ? ' data-weekend="1"' : ''
      }>
          <span class="cal-day">${Number(date.slice(8, 10))}</span>
          <span class="cal-value">${value === undefined ? '' : value}</span>
          <span class="cal-radios">${radiosFor(date, value, isPast, { hidden: true })}</span>
        </div>`;
    })
    .join('');

  return `<noscript>
      <div class="banner error">
        <strong>この端末ではカレンダーから入力できません。</strong>
        <p class="small">「一覧入力」に切り替えてください。同じ内容を入力できます。</p>
      </div>
    </noscript>

    <div class="calendar">${heads}${blanks}${cells}</div>

    <div class="cal-picker" id="cal-picker" hidden>
      <p class="cal-picker-date small"></p>
      <div class="pills">
        ${[...CAPACITY_CHOICES, CLEAR_VALUE]
          .map(
            (n) =>
              `<button type="button" class="pick" data-value="${n}">${n === CLEAR_VALUE ? '消す' : n}</button>`
          )
          .join('')}
      </div>
    </div>

    <p class="small muted">マスを押すと件数を選べます。「消す」で未入力に戻せます。</p>`;
}

/** 一覧入力（1日1行）。JavaScript が無くても動く */
function listView({ days, current, today }) {
  const rows = days
    .map((date) => {
      const value = current[date];
      const { dowClass, isPast, isUnset } = dayClass(date, value, today);

      return `<div class="avail-row${isPast ? ' past' : ''}${isUnset ? ' unset' : ''}"
                   data-day="${date}"${isPast ? ' data-past="1"' : ''}${dowClass ? ' data-weekend="1"' : ''}>
                <div class="avail-date ${dowClass}">${Number(date.slice(8, 10))}<span class="small">(${dayNameOf(date)})</span></div>
                <div class="pills">${radiosFor(date, value, isPast)}</div>
              </div>`;
    })
    .join('');

  return `<div class="avail-list">${rows}</div>`;
}

export async function saveAvailability(request, env, options = {}) {
  const auth = await requireStaff(request, env, options);
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  const form = await readForm(request);
  const month = String(form.month ?? '').slice(0, 7);
  const today = jstToday(options.now);

  const entries = [];
  const clears = [];

  for (const [key, value] of Object.entries(form)) {
    if (!key.startsWith('cap_')) continue;
    const date = key.slice(4);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    // 過去の日付は変更させない（画面上も無効にしてあるが、送信されても無視する）
    if (date < today) continue;

    const capacity = Number(Array.isArray(value) ? value[0] : value);

    // 「消す」＝未入力に戻す。0件（出勤できない）とは意味が違うので別扱いにする
    if (capacity === CLEAR_VALUE) {
      clears.push(date);
      continue;
    }
    if (!Number.isInteger(capacity) || capacity < 0 || capacity > 9) continue;
    entries.push({ date, capacity });
  }

  await setCapacityBulk(env.DB, auth.staff.id, entries, { updatedBy: auth.user.id });
  for (const date of clears) await clearCapacity(env.DB, auth.staff.id, date);

  const view = String(form.view ?? '') === 'list' ? '&view=list' : '';
  return redirect(`/me/availability?month=${month}&saved=1${view}`);
}

// ------------------------------------------------------------------
// /me/password … パスワード変更
// ------------------------------------------------------------------
export async function showPasswordForm(request, env, options = {}) {
  const auth = await requireUser(request, env, options);
  if (auth.response) return auth.response;

  return htmlResponse(passwordPage(auth.user));
}

function passwordPage(user, error = null, done = false) {
  return page({
    title: 'パスワード変更',
    user,
    body: html`
      <h2>パスワードの変更</h2>
      ${raw(error ? `<div class="banner error">${escapeHtml(error)}</div>` : '')}
      ${raw(done ? '<div class="banner ok">変更しました。</div>' : '')}
      ${raw(
        user.mustChange
          ? '<div class="banner"><strong>最初に、自分だけが分かるパスワードに変えてください。</strong></div>'
          : ''
      )}
      <form method="post" action="/me/password">
        <label for="current">いまのパスワード</label>
        <input id="current" name="current" type="password" autocomplete="current-password" required>

        <label for="next1">新しいパスワード</label>
        <input id="next1" name="next1" type="password" autocomplete="new-password" required minlength="8">
        <p class="small muted">8文字以上にしてください。</p>

        <label for="next2">新しいパスワード（確認）</label>
        <input id="next2" name="next2" type="password" autocomplete="new-password" required minlength="8">

        <p style="margin-top:20px"><button type="submit" class="primary">変更する</button></p>
      </form>
    `
  });
}

export async function changePassword(request, env, options = {}) {
  const auth = await requireUser(request, env, options);
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  const form = await readForm(request);
  const current = String(form.current ?? '');
  const next1 = String(form.next1 ?? '');
  const next2 = String(form.next2 ?? '');

  const { verifyLogin } = await import('../../db/users.js');
  const check = await verifyLogin(env.DB, auth.user.loginId, current, { pepper: env.SESSION_PEPPER ?? '' });
  if (!check.ok) {
    return htmlResponse(passwordPage(auth.user, 'いまのパスワードが違います。'), { status: 401 });
  }
  if (next1.length < 8) {
    return htmlResponse(passwordPage(auth.user, '新しいパスワードは8文字以上にしてください。'), { status: 400 });
  }
  if (next1 !== next2) {
    return htmlResponse(passwordPage(auth.user, '確認用のパスワードが一致しません。'), { status: 400 });
  }

  const iterations = await getSetting(env.DB, 'password_iterations', undefined);
  await setPassword(env.DB, auth.user.id, next1, {
    pepper: env.SESSION_PEPPER ?? '',
    ...(iterations ? { iterations: Number(iterations) } : {}),
    mustChange: false
  });

  return redirect(auth.user.role === 'admin' ? '/admin' : '/me');
}
