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
import { listAssignments, markCompleted, clearCompleted, getAssignment } from '../../db/assignments.js';
import { listForStaff, setCapacityBulk } from '../../db/availability.js';
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

  const today = jstToday(options.now);
  const to = addDays(today, SCHEDULE_DAYS);

  const rows = await listAssignments(env.DB, { from: today, to, staffName: auth.staff.name });

  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.cleaningDate)) byDate.set(row.cleaningDate, []);
    byDate.get(row.cleaningDate).push(row);
  }

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
                 <form method="post" action="/me/complete/${encodeURIComponent(a.bookingId)}" class="inline">
                   <input type="hidden" name="undo" value="1">
                   <button type="submit" class="link small">取り消す</button>
                 </form></p>`
              : `<form method="post" action="/me/complete/${encodeURIComponent(a.bookingId)}">
                   <button type="submit">清掃おわりました</button>
                 </form>`
          }
        </div>`
      )
      .join('');

    return `<div class="day"><span class="${dowClass}">${escapeHtml(toDisplayDate(date))}</span> ${badge}</div>${cards}`;
  });

  return htmlResponse(
    page({
      title: '予定',
      user: auth.user,
      body: html`
        <h2>${auth.staff.name}の予定</h2>
        <p class="small muted">
          ${todayCount > 0 ? `今日は ${todayCount}件です。` : '今日の予定はありません。'}
          （${toDisplayDate(today)} から ${SCHEDULE_DAYS}日分）
        </p>
        ${raw(sections.length > 0 ? sections.join('') : '<div class="card"><p>予定はありません。</p></div>')}
      `
    })
  );
}

/** 完了報告。自分の担当以外は変更できない */
export async function completeAssignment(request, env, params, options = {}) {
  const auth = await requireStaff(request, env, options);
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  const assignment = await getAssignment(env.DB, params.bookingId);
  if (!assignment || assignment.staffName !== auth.staff.name) {
    return new Response('対象が見つかりません。', { status: 404 });
  }

  const form = await readForm(request);
  if (form.undo) {
    await clearCompleted(env.DB, params.bookingId);
  } else {
    await markCompleted(env.DB, params.bookingId, { userId: auth.user.id });
  }

  return redirect('/me');
}

// ------------------------------------------------------------------
// /me/availability … 出勤可能件数の入力
// ------------------------------------------------------------------
const CAPACITY_CHOICES = [0, 1, 2, 3, 4, 5];

export async function showAvailability(request, env, options = {}) {
  const auth = await requireStaff(request, env, options);
  if (auth.response) return auth.response;

  const today = jstToday(options.now);
  const month = new URL(request.url).searchParams.get('month') ?? today.slice(0, 7);
  const saved = new URL(request.url).searchParams.get('saved') === '1';

  const days = monthDays(month);
  const current = await listForStaff(env.DB, auth.staff.id, {
    from: days[0],
    to: days[days.length - 1]
  });

  const missing = days.filter((d) => d >= today && current[d] === undefined).length;

  const rows = days
    .map((date) => {
      const dow = dowOf(date);
      const dowClass = dow === 0 ? 'sun' : dow === 6 ? 'sat' : '';
      const value = current[date];
      const isPast = date < today;

      const pills = CAPACITY_CHOICES.map((n) => {
        const id = `d${date}-${n}`;
        return `<input type="radio" id="${id}" name="cap_${date}" value="${n}"${value === n ? ' checked' : ''}${isPast ? ' disabled' : ''}>
                <label for="${id}">${n}</label>`;
      }).join('');

      return `<div class="avail-row${isPast ? ' past' : ''}${value === undefined && !isPast ? ' unset' : ''}">
                <div class="avail-date ${dowClass}">${Number(date.slice(8, 10))}<span class="small">(${dayNameOf(date)})</span></div>
                <div class="pills">${pills}</div>
              </div>`;
    })
    .join('');

  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);

  return htmlResponse(
    page({
      title: '出勤入力',
      user: auth.user,
      body: html`
        <h2>${monthLabel(month)}の出勤</h2>
        ${raw(saved ? '<div class="banner ok">保存しました。</div>' : '')}
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

          <div class="presets small">
            まとめて入力:
            <button type="button" class="bulk" data-days="weekday" data-value="3">平日すべて3件</button>
            <button type="button" class="bulk" data-days="all" data-value="0">すべて0件</button>
          </div>

          <div class="avail-list">${raw(rows)}</div>

          <p class="sticky-save"><button type="submit" class="primary">この月をまとめて保存</button></p>
        </form>

        <p class="small">
          <a href="/me/availability?month=${prev}">← ${monthLabel(prev)}</a>
          &nbsp;/&nbsp;
          <a href="/me/availability?month=${next}">${monthLabel(next)} →</a>
        </p>
      `
    })
  );
}

export async function saveAvailability(request, env, options = {}) {
  const auth = await requireStaff(request, env, options);
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  const form = await readForm(request);
  const month = String(form.month ?? '').slice(0, 7);
  const today = jstToday(options.now);

  const entries = [];
  for (const [key, value] of Object.entries(form)) {
    if (!key.startsWith('cap_')) continue;
    const date = key.slice(4);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    // 過去の日付は変更させない（画面上も無効にしてあるが、送信されても無視する）
    if (date < today) continue;

    const capacity = Number(Array.isArray(value) ? value[0] : value);
    if (!Number.isInteger(capacity) || capacity < 0 || capacity > 9) continue;
    entries.push({ date, capacity });
  }

  await setCapacityBulk(env.DB, auth.staff.id, entries, { updatedBy: auth.user.id });

  return redirect(`/me/availability?month=${month}&saved=1`);
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
