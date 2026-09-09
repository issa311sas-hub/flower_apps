/**
 * 管理者画面（M4では最小限）
 *
 *   /admin        … 状況の確認
 *   /admin/staff  … スタッフのアカウント作成とパスワード発行
 *
 * 割り当て一覧・タイムライン・設定・Beds24接続は M5 で作る。
 */

import { html, page, htmlResponse, redirect, raw, escapeHtml } from '../html.js';
import { requireUser, checkOrigin, readForm } from '../auth.js';
import { listUsers, createUser, setPassword, setUserActive, getUserById, generatePassword } from '../../db/users.js';
import { listStaff } from '../../db/staff.js';
import { getRunHealth, listRuns } from '../../db/runs.js';
import { listUnacknowledged } from '../../db/notifications.js';
import { getAuthStatus } from '../../db/beds24Auth.js';
import { listUnitMap } from '../../db/units.js';
import { listAssignments } from '../../db/assignments.js';
import { DEFAULT_PARAMS } from '../../core/assign.js';
import { hasWebhook } from '../../integrations/slack.js';
import { listPendingMigrations } from '../../db/migrate.js';
import { MIGRATIONS } from '../../db/migrations.js';
import { countMissingDays } from '../../db/availability.js';
import { getSetting } from '../../db/settings.js';
import { jstToday, addDays } from '../../core/dates.js';

export async function showAdminHome(request, env, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;

  const nowMs = options.now ?? Date.now();
  const today = jstToday(nowMs);

  const [health, beds24, notices, runs, missing, unitMap, slackOn, soon, allStaff, pending] = await Promise.all([
    getRunHealth(env.DB, nowMs),
    getAuthStatus(env.DB, nowMs),
    listUnacknowledged(env.DB, 5),
    listRuns(env.DB, 5),
    countMissingDays(env.DB, { from: today, to: addDays(today, 30) }),
    listUnitMap(env.DB),
    hasWebhook(env.DB),
    // 外注は実費なので、いちばん先に目に入る場所で件数を出す
    listAssignments(env.DB, { from: today, to: addDays(today, 14) }),
    listStaff(env.DB, { includeInactive: true }),
    listPendingMigrations(env.DB, MIGRATIONS)
  ]);

  const outsourceName = allStaff.find((s) => s.kind === 'outsource')?.name ?? null;
  const soonOutsourced = soon.filter((a) => a.staffName === outsourceName).length;
  const soonUnassigned = soon.filter((a) => a.staffName === DEFAULT_PARAMS.unassignedLabel).length;

  const banners = notices
    .map(
      (n) =>
        `<div class="banner ${n.level === 'error' ? 'error' : ''}">
           <strong>${escapeHtml(n.subject)}</strong>
           <p class="small">${escapeHtml(n.body).replace(/\n/g, '<br>')}</p>
         </div>`
    )
    .join('');

  const runRows = runs
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.started_at ?? '')}</td><td>${escapeHtml(r.kind)}</td>
         <td>${r.ok === 1 ? '正常' : r.ok === 0 ? '失敗' : '実行中'}</td>
         <td>${escapeHtml(r.message ?? r.error ?? '')}</td></tr>`
    )
    .join('');

  const missingRows = missing
    .map((m) => `<tr><td>${escapeHtml(m.name)}</td><td>${m.filled} 日分</td></tr>`)
    .join('');

  return htmlResponse(
    page({
      title: '管理',
      user: auth.user,
      body: html`
        ${raw(
          pending.length > 0
            ? `<div class="banner error">
                 <strong>データベースの更新が ${pending.length}件 あります。</strong>
                 <p class="small">新しく足した機能は、更新するまで使えません。
                 既存のデータには触りません。</p>
                 <form method="post" action="/admin/migrate">
                   <p><button type="submit" class="primary">いま更新する</button></p>
                 </form>
               </div>`
            : ''
        )}

        <h2>状況</h2>
        ${raw(banners)}

        <table>
          <tr><th>自動実行</th><td>${
            health.neverRun
              ? 'まだ一度も成功していません'
              : `${health.lastSuccessAt}（${health.staleDays}日前）${health.isStale ? ' ⚠ 滞留しています' : ''}`
          }</td></tr>
          <tr><th>Beds24</th><td>${escapeHtml(beds24.state)}${
            beds24.daysUntilExpiry !== null ? `（失効まで約${beds24.daysUntilExpiry}日）` : ''
          }</td></tr>
          <tr><th>Slack 通知</th><td>${slackOn ? '設定済み' : '未設定'}</td></tr>
          <tr><th>今後14日</th><td>
            清掃 ${soon.length}件 /
            <strong>外注 ${soonOutsourced}件</strong> /
            未割当 ${soonUnassigned}件
          </td></tr>
        </table>

        ${raw(
          slackOn
            ? ''
            : `<div class="banner">
                 <strong>Slack への通知が未設定です。</strong>
                 <p class="small">いまは、自動実行が止まってもこの画面を開くまで気づけません。</p>
                 <p><a class="btn" href="/admin/settings">通知を設定する</a></p>
               </div>`
        )}

        ${raw(setupWarning(beds24, unitMap.length))}

        <h2>スタッフの入力状況（今後30日）</h2>
        <p class="small muted"><a href="/admin/availability">月ごとの入力内容を見る</a></p>
        <div class="scroll-x"><table>
          <tr><th>担当者</th><th>入力済み</th></tr>
          ${raw(missingRows)}
        </table></div>

        <h2>最近の実行</h2>
        <div class="scroll-x"><table>
          <tr><th>日時</th><th>種別</th><th>結果</th><th>内容</th></tr>
          ${raw(runRows || '<tr><td colspan="4">まだ実行されていません</td></tr>')}
        </table></div>

        <h2>操作</h2>
        <form method="post" action="/admin/run">
          <p><button type="submit" class="primary">いま実行する</button></p>
          <p class="small muted">
            Beds24 から予約を取り直し、担当を割り当て直します。20秒ほどかかることがあります。
          </p>
        </form>

        <form method="post" action="/admin/run"
              data-confirm="いまの割り当てをいったん白紙に戻して、決め直します。よろしいですか？">
          <input type="hidden" name="rebuild" value="1">
          <p><button type="submit">ゼロから割り当て直す</button></p>
          <p class="small muted">
            いまの担当をいったん白紙に戻してから決め直します。
            <strong>あとから出勤入力を増やしたのに担当が変わらないとき</strong>に使ってください。
            手で固定した分と、完了報告が済んだ分はそのまま残ります。
          </p>
        </form>

        <p class="links">
          <a class="btn" href="/admin/assignments">割り当て一覧</a>
          <a class="btn" href="/admin/timeline">タイムライン</a>
          <a class="btn" href="/admin/availability">出勤入力の状況</a>
          <a class="btn" href="/admin/reports">完了報告・現地精算</a>
          <a class="btn" href="/admin/beds24">Beds24・ユニット対応づけ</a>
          <a class="btn" href="/admin/runs">実行ログと警告</a>
          <a class="btn" href="/admin/staff">スタッフのアカウント</a>
          <a class="btn" href="/admin/settings">設定・Slack通知</a>
        </p>

      `
    })
  );
}

/**
 * 「まだ使える状態になっていない」ことを最初に伝える。
 * 接続と対応づけのどちらが欠けても予約は1件も入らないため、
 * 空の一覧を見て悩ませない。
 */
function setupWarning(beds24, unitMapCount) {
  if (!beds24.hasToken) {
    return `<div class="banner error">
        <strong>Beds24 につながっていません。</strong>
        <p class="small">予約を取り込めないため、清掃予定は作られません。</p>
        <p><a class="btn primary" href="/admin/beds24">Beds24 につなぐ</a></p>
      </div>`;
  }

  if (unitMapCount === 0) {
    return `<div class="banner error">
        <strong>ユニットの対応づけが未登録です。</strong>
        <p class="small">Beds24 の部屋がこちらの b2〜c4 のどれに当たるか分からないため、
        取得した予約を1件も取り込めません。</p>
        <p><a class="btn primary" href="/admin/beds24">対応づけを登録する</a></p>
      </div>`;
  }

  return '';
}

// ------------------------------------------------------------------
// /admin/staff
// ------------------------------------------------------------------
export async function showAdminStaff(request, env, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;

  return htmlResponse(await staffPage(env, auth.user));
}

async function staffPage(env, currentUser, issued = null, error = null) {
  const [users, staff] = await Promise.all([listUsers(env.DB), listStaff(env.DB)]);

  const userRows = users
    .map(
      (u) => `<tr>
        <td>${escapeHtml(u.loginId)}</td>
        <td>${escapeHtml(u.displayName)}</td>
        <td>${u.role === 'admin' ? '管理者' : escapeHtml(u.staffName ?? '—')}</td>
        <td>${u.isActive ? '有効' : '停止中'}${u.mustChange ? '<br><span class="small muted">初回変更待ち</span>' : ''}</td>
        <td>
          <form method="post" action="/admin/staff/${u.id}/password" class="inline">
            <button type="submit">パスワード発行</button>
          </form>
          ${
            u.id === currentUser.id
              ? ''
              : `<form method="post" action="/admin/staff/${u.id}/active" class="inline">
                   <input type="hidden" name="active" value="${u.isActive ? '0' : '1'}">
                   <button type="submit" class="link small">${u.isActive ? '停止' : '再開'}</button>
                 </form>`
          }
        </td>
      </tr>`
    )
    .join('');

  const staffOptions = staff
    .filter((s) => s.kind === 'staff')
    .map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`)
    .join('');

  const issuedBlock = issued
    ? `<div class="banner ok">
         <strong>${escapeHtml(issued.displayName)} のパスワードを発行しました</strong>
         <p class="small">この画面を閉じると二度と表示されません。いま控えて、本人に伝えてください。</p>
         <div class="copy-row">
           <input id="issued" type="text" value="${escapeHtml(issued.password)}" readonly>
           <button type="button" class="copy" data-target="issued">コピー</button>
         </div>
         <p class="small">ID: <strong>${escapeHtml(issued.loginId)}</strong></p>
       </div>`
    : '';

  return page({
    title: 'スタッフ管理',
    user: currentUser,
    body: html`
      <h2>アカウント</h2>
      ${raw(error ? `<div class="banner error">${escapeHtml(error)}</div>` : '')}
      ${raw(issuedBlock)}

      <div class="scroll-x"><table>
        <tr><th>ID</th><th>表示名</th><th>担当者</th><th>状態</th><th></th></tr>
        ${raw(userRows)}
      </table></div>

      <h2>アカウントを追加</h2>
      <form method="post" action="/admin/staff">
        <label for="login_id">ログインID</label>
        <input id="login_id" name="login_id" required autocapitalize="none"
               placeholder="hosoda" pattern="[A-Za-z0-9_.-]+">
        <p class="small muted">半角英数字。本人が覚えやすいものにしてください。</p>

        <label for="display_name">表示名</label>
        <input id="display_name" name="display_name" required placeholder="細田さん">

        <label for="staff_id">担当者</label>
        <select id="staff_id" name="staff_id">
          <option value="">（管理者：清掃は担当しない）</option>
          ${raw(staffOptions)}
        </select>
        <p class="small muted">清掃を担当する人は、ここで担当者を選んでください。</p>

        <p style="margin-top:20px"><button type="submit" class="primary">追加してパスワードを発行</button></p>
      </form>
    `
  });
}

export async function createStaffUser(request, env, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  const form = await readForm(request);
  const loginId = String(form.login_id ?? '').trim();
  const displayName = String(form.display_name ?? '').trim();
  const staffId = form.staff_id ? Number(form.staff_id) : null;

  if (!loginId || !displayName) {
    return htmlResponse(await staffPage(env, auth.user, null, 'IDと表示名を入力してください。'), { status: 400 });
  }

  const iterations = await getSetting(env.DB, 'password_iterations', undefined);

  try {
    const created = await createUser(
      env.DB,
      { loginId, displayName, role: staffId ? 'staff' : 'admin', staffId },
      { pepper: env.SESSION_PEPPER ?? '', ...(iterations ? { iterations: Number(iterations) } : {}) }
    );

    return htmlResponse(
      await staffPage(env, auth.user, { loginId, displayName, password: created.password })
    );
  } catch (error) {
    const message = String(error?.message ?? error).includes('UNIQUE')
      ? `ログインID「${loginId}」はすでに使われています。`
      : `作成できませんでした: ${error?.message ?? error}`;
    return htmlResponse(await staffPage(env, auth.user, null, message), { status: 400 });
  }
}

export async function reissuePassword(request, env, params, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  const target = await getUserById(env.DB, Number(params.id));
  if (!target) return new Response('対象が見つかりません。', { status: 404 });

  const password = generatePassword();
  const iterations = await getSetting(env.DB, 'password_iterations', undefined);

  await setPassword(env.DB, target.id, password, {
    pepper: env.SESSION_PEPPER ?? '',
    ...(iterations ? { iterations: Number(iterations) } : {}),
    mustChange: true
  });

  return htmlResponse(
    await staffPage(env, auth.user, { loginId: target.loginId, displayName: target.displayName, password })
  );
}

export async function toggleStaffUser(request, env, params, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  const form = await readForm(request);
  const target = Number(params.id);

  // 自分自身は停止できない（管理者が誰もいなくなるのを防ぐ）
  if (target === auth.user.id) return redirect('/admin/staff');

  await setUserActive(env.DB, target, String(form.active) === '1');
  return redirect('/admin/staff');
}

