/**
 * タイムライン（管理者専用）
 *
 *   GET /admin/timeline … ユニット × 日付 で全体を俯瞰する
 *
 * 旧版のタイムラインシートの置き換え。日付順のリストだけでは
 * 「この日、どの棟が空いているか」が読み取れないため、縦横の表にする。
 *
 * 表の下に**スタッフの出勤枠**を並べているのが要点。
 * 外注や未割当が出ている日は、たいてい真下の枠が 0 か未入力になっている。
 * 「なぜそうなったか」が同じ画面で分かるようにするための行。
 */

import { html, page, htmlResponse, raw, escapeHtml } from '../html.js';
import { requireUser } from '../auth.js';
import { listAssignments } from '../../db/assignments.js';
import { listUnits } from '../../db/units.js';
import { listStaff } from '../../db/staff.js';
import { getAvailabilityMaps } from '../../db/availability.js';
import { jstToday, addDays, dayNameOf, rangeDays } from '../../core/dates.js';
import { weekendClass } from '../calendar.js';
import { DEFAULT_PARAMS } from '../../core/assign.js';
import { EXCLUDED_LABEL } from '../../core/exclude.js';

const DAY_CHOICES = [7, 14, 30];
const DEFAULT_DAYS = 14;

export async function showTimeline(request, env, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;

  const params = new URL(request.url).searchParams;
  const days = DAY_CHOICES.includes(Number(params.get('days'))) ? Number(params.get('days')) : DEFAULT_DAYS;

  const today = jstToday(options.now);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(params.get('from') ?? '') ? params.get('from') : today;
  const to = addDays(from, days - 1);
  const dates = rangeDays(from, days);

  const [units, assignments, staff, maps] = await Promise.all([
    listUnits(env.DB),
    listAssignments(env.DB, { from, to }),
    listStaff(env.DB),
    getAvailabilityMaps(env.DB, { from, to })
  ]);
  const { capacity, checkinLimits } = maps;

  const byName = new Map(staff.map((s) => [s.name, s]));

  // 'unit\ndate' で引けるようにしておく（1日に同じユニットが2件入ることは通常ない）
  const cells = new Map();
  for (const a of assignments) cells.set(`${a.unit}\n${a.cleaningDate}`, a);

  const header = dates
    .map((d) => `<th class="${weekendClass(d)}">${Number(d.slice(8, 10))}<br><span class="small">${dayNameOf(d)}</span></th>`)
    .join('');

  const unitRows = units
    .map((unit) => {
      const tds = dates
        .map((date) => {
          const a = cells.get(`${unit.name}\n${date}`);
          if (!a) return `<td class="${weekendClass(date)}"></td>`;

          const staffInfo = byName.get(a.staffName);
          const label = staffInfo?.shortName || a.staffName;

          return `<td class="${cellClass(a, byName)}">
              <a href="/admin/assignments/${encodeURIComponent(a.bookingId)}"
                 title="${escapeHtml(`${a.unit} / ${a.staffName} / ${a.status}`)}">${escapeHtml(label)}</a>
              ${a.completedAt ? '<span class="done-mark">✓</span>' : ''}
              ${a.isManual ? '<span class="manual-mark">固</span>' : ''}
            </td>`;
        })
        .join('');

      return `<tr><th class="unit-col">${escapeHtml(unit.name)}</th>${tds}</tr>`;
    })
    .join('');

  // 出勤枠。未入力は「-」にする（0件の入力とは意味が違うので区別する）
  const capacityRows = staff
    .filter((s) => s.usesAvailability)
    .map((s) => {
      const tds = dates
        .map((date) => {
          const value = capacity[s.name]?.[date];
          const isUnset = value === undefined;
          const isPm = checkinLimits[s.name]?.[date] !== undefined;
          return `<td class="${cls(weekendClass(date), isUnset ? 'unset' : '', isPm ? 'pm-slot' : '')}">${
            isUnset ? '-' : isPm ? '13:30' : value
          }</td>`;
        })
        .join('');
      return `<tr><th class="unit-col">${escapeHtml(s.shortName || s.name)}</th>${tds}</tr>`;
    })
    .join('');

  const unassigned = assignments.filter((a) => a.staffName === DEFAULT_PARAMS.unassignedLabel).length;
  const outsourced = assignments.filter((a) => byName.get(a.staffName)?.kind === 'outsource').length;

  return htmlResponse(
    page({
      title: 'タイムライン',
      user: auth.user,
      body: html`
        <h2>${from} から ${days}日</h2>

        <p class="small">
          ${assignments.length}件（<strong>未割当 ${unassigned}件</strong> / 外注 ${outsourced}件）
        </p>

        <div class="scroll-x">
          <table class="timeline">
            <tr><th class="unit-col">ユニット</th>${raw(header)}</tr>
            ${raw(unitRows)}
            <tr class="section"><th class="unit-col">出勤枠</th>${raw(dates.map(() => '<td></td>').join(''))}</tr>
            ${raw(capacityRows)}
          </table>
        </div>

        <p class="small muted">
          下段は各スタッフがその日に清掃できる件数です。<strong>「-」は未入力</strong>で、
          「出勤できない（0件）」として扱われます。
          外注や未割当が出ている日は、その日の枠が足りていないか、入力がありません。
          <a href="/admin/availability">月ごとの入力状況を見る</a>
        </p>

        <p class="links">
          ${raw(
            DAY_CHOICES.map(
              (n) =>
                `<a class="btn" href="/admin/timeline?from=${from}&days=${n}">${n}日</a>`
            ).join('')
          )}
        </p>
        <p class="small">
          <a href="/admin/timeline?from=${addDays(from, -days)}&days=${days}">← 前の${days}日</a>
          &nbsp;/&nbsp;
          <a href="/admin/timeline?from=${today}&days=${days}">今日から</a>
          &nbsp;/&nbsp;
          <a href="/admin/timeline?from=${addDays(from, days)}&days=${days}">次の${days}日 →</a>
        </p>

        <p style="margin-top:24px"><a class="btn" href="/admin/assignments">一覧で見る</a></p>
      `
    })
  );
}

/** 空の値を混ぜても余計な空白が入らないようにする */
function cls(...parts) {
  return parts.filter(Boolean).join(' ');
}

/** 一覧と同じ色分け規則にそろえる */
function cellClass(assignment, byName) {
  const base = weekendClass(assignment.cleaningDate);
  if (assignment.staffName === DEFAULT_PARAMS.unassignedLabel) return cls(base, 'cell-unassigned');
  if (assignment.staffName === EXCLUDED_LABEL) return cls(base, 'cell-excluded');

  const staff = byName.get(assignment.staffName);
  if (!staff) return base;
  if (staff.kind === 'outsource') return cls(base, 'cell-outsource');
  return cls(base, `cell-staff-${Math.min(staff.priority, 3)}`);
}
