/**
 * 完了報告と現地精算の集計（管理者専用）
 *
 *   GET /admin/reports … 月ごと。上段に清掃員ごとの現地精算合計、下段に報告一覧
 *
 * ★上段が本題。現地精算金額は「お客さんが現地に置いていった現金を清掃員が回収した額」で、
 *   事実上の給与の前払い。**給与から差し引く額**をここで確定させる。
 *   旧運用ではメッセージを月末に遡って手で足していた。
 */

import { html, page, htmlResponse, raw, escapeHtml } from '../html.js';
import { requireUser } from '../auth.js';
import { listReports, sumSettlements, getReport, CONDITIONS, SERVICE_VALUES } from '../../db/reports.js';
import { jstToday, toDisplayDate, monthDays, shiftMonth, monthLabel } from '../../core/dates.js';

const CONDITION_LABEL = Object.fromEntries(CONDITIONS.map((c) => [c.value, c.label]));
const SERVICE_LABEL = Object.fromEntries(SERVICE_VALUES.map((v) => [v.value, v.label]));

export async function showReports(request, env, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;

  const today = jstToday(options.now);
  const requested = new URL(request.url).searchParams.get('month') ?? '';
  const month = /^\d{4}-\d{2}$/.test(requested) ? requested : today.slice(0, 7);

  const days = monthDays(month);
  const range = { from: days[0], to: days[days.length - 1] };

  const [totals, reports] = await Promise.all([sumSettlements(env.DB, range), listReports(env.DB, range)]);

  const grandTotal = totals.reduce((sum, t) => sum + t.total, 0);

  const totalRows = totals
    .map(
      (t) => `<tr>
        <th>${escapeHtml(t.staffName)}</th>
        <td class="yen"><strong>${t.total.toLocaleString()}円</strong></td>
        <td>${t.count}件の報告${t.withCash > 0 ? `（うち受取 ${t.withCash}件）` : ''}</td>
      </tr>`
    )
    .join('');

  const reportRows = reports
    .map((r) => {
      const alerts = [];
      if (r.condition === 'F') alerts.push('受け入れ拒否');
      if (r.ngEquipment.length > 0) alerts.push(`設備✕ ${escapeHtml(r.ngEquipment.join('/'))}`);
      if (r.uncleanedServices.length > 0) alerts.push(`未清掃 ${escapeHtml(r.uncleanedServices.join('/'))}`);

      return `<tr class="${alerts.length > 0 ? 'unassigned' : ''}">
        <td>${escapeHtml(toDisplayDate(r.cleaningDate))}</td>
        <td>${escapeHtml(r.unit)}</td>
        <td>${escapeHtml(r.staffName)}</td>
        <td>${escapeHtml(r.condition)}</td>
        <td class="yen">${r.settlementYen > 0 ? `${r.settlementYen.toLocaleString()}円` : ''}</td>
        <td>${alerts.join(' / ')}</td>
        <td><a href="/admin/reports/${encodeURIComponent(r.bookingId)}">詳細</a></td>
      </tr>`;
    })
    .join('');

  return htmlResponse(
    page({
      title: '完了報告',
      user: auth.user,
      body: html`
        <h2>${monthLabel(month)}の現地精算</h2>
        <p class="small muted">
          清掃員がお客さんから受け取った金額です。<strong>給与から差し引く額</strong>になります。
        </p>

        <table>
          <tr><th>清掃員</th><th>差し引く額</th><th></th></tr>
          ${raw(totalRows || '<tr><td colspan="3">この月の報告はまだありません。</td></tr>')}
          ${raw(
            totals.length > 0
              ? `<tr><th>合計</th><td class="yen"><strong>${grandTotal.toLocaleString()}円</strong></td><td></td></tr>`
              : ''
          )}
        </table>

        <h2>報告の一覧（${reports.length}件）</h2>
        <div class="scroll-x"><table>
          <tr><th>清掃日</th><th>ユニット</th><th>清掃員</th><th>状況</th><th>現地精算</th><th>要確認</th><th></th></tr>
          ${raw(reportRows || '<tr><td colspan="7">この月の報告はまだありません。</td></tr>')}
        </table></div>

        <p class="small muted">
          状況は ${raw(CONDITIONS.map((c) => `${c.value}=${escapeHtml(c.label)}`).join(' / '))} です。
        </p>

        <p class="small">
          <a href="/admin/reports?month=${shiftMonth(month, -1)}">← ${monthLabel(shiftMonth(month, -1))}</a>
          &nbsp;/&nbsp;
          <a href="/admin/reports?month=${today.slice(0, 7)}">今月</a>
          &nbsp;/&nbsp;
          <a href="/admin/reports?month=${shiftMonth(month, 1)}">${monthLabel(shiftMonth(month, 1))} →</a>
        </p>
      `
    })
  );
}

export async function showReportDetail(request, env, params, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;

  const report = await getReport(env.DB, params.bookingId);
  if (!report) return new Response('報告が見つかりません。', { status: 404 });

  const answerRows = report.answers
    .map(
      (a) => `<tr>
        <th>${escapeHtml(a.label)}</th>
        <td>${a.kind === 'equipment' ? (a.value === 'ok' ? '◯' : '<strong>✕</strong>') : escapeHtml(SERVICE_LABEL[a.value] ?? a.value)}</td>
      </tr>`
    )
    .join('');

  return htmlResponse(
    page({
      title: '完了報告の詳細',
      user: auth.user,
      body: html`
        <h2>${report.unit}（${toDisplayDate(report.cleaningDate)}）</h2>

        <table>
          <tr><th>清掃員</th><td>${report.staffName}</td></tr>
          <tr><th>使用状況</th><td>${report.condition} ${CONDITION_LABEL[report.condition] ?? ''}</td></tr>
          <tr><th>現地精算</th><td class="yen"><strong>${report.settlementYen.toLocaleString()}円</strong></td></tr>
          <tr><th>ひとこと</th><td>${report.note || '—'}</td></tr>
          <tr><th>報告日時</th><td>${report.reportedAt}</td></tr>
        </table>

        <h2>確認した項目</h2>
        <table>${raw(answerRows || '<tr><td>記録がありません。</td></tr>')}</table>

        <p style="margin-top:24px">
          <a class="btn" href="/admin/reports?month=${report.cleaningDate.slice(0, 7)}">一覧に戻る</a>
        </p>
      `
    })
  );
}
