/**
 * 割り当て一覧（管理者専用・M5-a では読み取りのみ）
 *
 *   GET /admin/assignments … 期間・担当者で絞って一覧する
 *
 * 旧版の「割り当て結果」シートに相当する。自動実行の結果がここで見えないと
 * 正しく動いているか確認できないため、手動変更より先に作っている。
 * 担当の手動変更（setManual / clearManual）とタイムラインは次の工程。
 */

import { html, page, htmlResponse, raw, escapeHtml } from '../html.js';
import { requireUser } from '../auth.js';
import { listAssignments } from '../../db/assignments.js';
import { listStaff } from '../../db/staff.js';
import { jstToday, addDays, toDisplayDate } from '../../core/dates.js';
import { DEFAULT_PARAMS } from '../../core/assign.js';

const DEFAULT_RANGE_DAYS = 30;

export async function showAssignments(request, env, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;

  const params = new URL(request.url).searchParams;
  const today = jstToday(options.now);

  const from = ymdOr(params.get('from'), today);
  const to = ymdOr(params.get('to'), addDays(from, DEFAULT_RANGE_DAYS));
  const staffName = params.get('staff') || null;

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
      </tr>`
    )
    .join('');

  const staffOptions = ['', ...staff.map((s) => s.name), DEFAULT_PARAMS.unassignedLabel]
    .map(
      (name) =>
        `<option value="${escapeHtml(name)}"${staffName === name ? ' selected' : ''}>${
          name === '' ? '（全員）' : escapeHtml(name)
        }</option>`
    )
    .join('');

  return htmlResponse(
    page({
      title: '割り当て',
      user: auth.user,
      body: html`
        <h2>清掃の割り当て</h2>

        <form method="get" action="/admin/assignments" class="filters">
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
            <select id="staff" name="staff">${raw(staffOptions)}</select>
          </div>
          <div><button type="submit">絞り込む</button></div>
        </form>

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

        <div class="scroll-x"><table>
          <tr><th>清掃日</th><th>ユニット</th><th>担当</th><th>状態</th><th>退去</th><th>次</th><th>完了</th><th>特殊要望</th></tr>
          ${raw(body || '<tr><td colspan="8">この期間の予定はありません。</td></tr>')}
        </table></div>

        <p class="small muted">
          担当の手動変更とタイムラインは次の工程で作ります。
        </p>
      `
    })
  );
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
