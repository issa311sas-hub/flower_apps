/**
 * Beds24 の接続とユニット対応づけ（管理者専用）
 *
 *   GET  /admin/beds24          … 接続状態・招待コードの入力・対応づけ表
 *   POST /admin/beds24          … 招待コードで接続する
 *   POST /admin/beds24/discover … 予約に出てくる roomId:unitId を調べる（旧版の「🔍 Beds24 roomId確認」）
 *   POST /admin/beds24/map      … 対応づけを保存する
 *
 * この対応表（unit_map）が空だと、取得した予約がどのユニットのものか分からず
 * 1件も取り込めない。初期データにも入れられない（値が事業所ごとに違う）ため、
 * ここで登録してもらう必要がある。
 *
 * 招待コードはパスワードと同じ扱いにする。**画面にも実行ログにも通知にも残さない。**
 */

import { html, page, htmlResponse, redirect, raw, escapeHtml } from '../html.js';
import { requireUser, checkOrigin, readForm, formList } from '../auth.js';
import { getAuthStatus, STATE, REFRESH_TOKEN_EXPIRE_DAYS } from '../../db/beds24Auth.js';
import { connectWithInviteCode, discoverRoomIds } from '../../integrations/beds24.js';
import { listUnitNames, listUnitMap, replaceUnitMap } from '../../db/units.js';
import { getSetting } from '../../db/settings.js';
import { jstToday } from '../../core/dates.js';

/** テストから fetch を差し替えられるようにする（本番では素の fetch が使われる） */
function overridesFrom(options) {
  const out = {};
  if (options.fetchImpl) out.fetch = options.fetchImpl;
  if (options.sleep) out.sleep = options.sleep;
  if (options.now !== undefined) out.now = () => options.now;
  return out;
}

// ------------------------------------------------------------------
// 画面
// ------------------------------------------------------------------

export async function showBeds24(request, env, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;

  const params = new URL(request.url).searchParams;
  const notice =
    params.get('connected') === '1'
      ? 'Beds24 につながりました。続けて、下の「ユニットの対応づけ」を登録してください。'
      : params.get('mapped') === '1'
        ? '対応づけを保存しました。「いま実行する」で予約を取り込めます。'
        : null;

  return htmlResponse(await beds24Page(env, auth.user, { notice, now: options.now }));
}

/**
 * @param {{notice?: string, error?: string, discovered?: Array, now?: number}} view
 */
async function beds24Page(env, user, view = {}) {
  const nowMs = view.now ?? Date.now();
  const [status, unitNames, existing] = await Promise.all([
    getAuthStatus(env.DB, nowMs),
    listUnitNames(env.DB),
    listUnitMap(env.DB)
  ]);

  const hasEncKey = !!env.TOKEN_ENC_KEY;
  const rows = mergeRows(existing, view.discovered);

  return page({
    title: 'Beds24',
    user,
    body: html`
      <h2>Beds24 との接続</h2>
      ${raw(view.notice ? `<div class="banner ok">${escapeHtml(view.notice)}</div>` : '')}
      ${raw(view.error ? `<div class="banner error"><strong>${escapeHtml(view.error)}</strong></div>` : '')}

      ${raw(statusBlock(status))}
      ${raw(hasEncKey ? connectForm(status) : missingKeyBlock())}

      <h2>ユニットの対応づけ</h2>
      <p class="small muted">
        Beds24 の部屋（roomId・unitId）が、こちらの b2〜c4 のどれに当たるかの表です。
        <strong>ここが空だと予約を1件も取り込めません。</strong>
      </p>
      ${raw(mapSection(rows, unitNames, status, view.discovered !== undefined))}
    `
  });
}

function statusBlock(status) {
  const connected = status.hasToken;
  const expiry =
    status.daysUntilExpiry === null
      ? '—'
      : `あと約 ${status.daysUntilExpiry}日（${REFRESH_TOKEN_EXPIRE_DAYS}日使わないと失効します）`;

  return `<table>
      <tr><th>状態</th><td>${escapeHtml(status.state)}${connected ? '' : '（まだつながっていません）'}</td></tr>
      <tr><th>最後に成功</th><td>${escapeHtml(status.lastOkAt ?? '—')}</td></tr>
      <tr><th>失効まで</th><td>${escapeHtml(expiry)}</td></tr>
      ${status.lastError ? `<tr><th>直近のエラー</th><td>${escapeHtml(status.lastError)}</td></tr>` : ''}
    </table>`;
}

function missingKeyBlock() {
  return `<div class="banner error">
      <strong>先に秘密の鍵（TOKEN_ENC_KEY）を登録してください。</strong>
      <p class="small">Beds24 のトークンはこの鍵で暗号化して保存するため、
      鍵がないと接続できません。</p>
      <p><a class="btn" href="/setup/keys">鍵の登録について見る</a></p>
    </div>`;
}

function connectForm(status) {
  const heading = status.hasToken ? 'つなぎ直す' : '接続する';

  return `<h2>${heading}</h2>
    <div class="banner">
      <p class="small">Beds24 の管理画面 → <strong>SETTINGS → MARKETPLACE → API</strong> で招待コードを発行し、
      下に貼り付けてください。</p>
      <ul class="small">
        <li>スコープに <strong>bookings</strong> と <strong>properties</strong> を含めてください</li>
        <li>招待コードの有効期限は<strong>発行から24時間</strong>です</li>
        <li>いま動いている旧システムの接続とは別に発行されます</li>
      </ul>
    </div>
    <form method="post" action="/admin/beds24" autocomplete="off">
      <label for="invite_code">招待コード</label>
      <input id="invite_code" name="invite_code" type="password" required
             autocomplete="off" autocapitalize="none" spellcheck="false">
      <p class="small muted">パスワードと同じ扱いです。この画面に再表示されることはありません。</p>
      <p style="margin-top:20px"><button type="submit" class="primary">${heading}</button></p>
    </form>`;
}

/**
 * 対応づけの表。
 *
 * 「今回発見した組み合わせ」と「すでに登録済みの対応」の**和集合**を出す。
 * 保存は丸ごと入れ替え（replaceUnitMap）なので、取得期間にたまたま予約が無かった
 * 部屋をここに出しておかないと、保存した瞬間にその対応が消えてしまう。
 */
function mapSection(rows, unitNames, status, didDiscover) {
  const discoverButton = status.hasToken
    ? `<form method="post" action="/admin/beds24/discover">
         <p><button type="submit">Beds24 からルームIDを調べる</button></p>
         <p class="small muted">予約データに出てくる部屋の一覧を取り出します。保存はまだされません。</p>
       </form>`
    : '<p class="small muted">先に接続すると、ルームIDを調べられるようになります。</p>';

  if (rows.length === 0) {
    return `${discoverButton}
      ${didDiscover ? '<div class="banner"><strong>予約が1件も見つかりませんでした。</strong><p class="small">取得する期間（設定の fetch_days）に予約が無いか、Beds24 側の権限が足りない可能性があります。</p></div>' : ''}`;
  }

  const body = rows
    .map((r, i) => {
      const options = [`<option value="">（使わない）</option>`]
        .concat(
          unitNames.map(
            (name) =>
              `<option value="${escapeHtml(name)}"${r.unitName === name ? ' selected' : ''}>${escapeHtml(name)}</option>`
          )
        )
        .join('');

      return `<tr>
        <td>
          <input type="hidden" name="room_id" value="${escapeHtml(r.roomId)}">
          <input type="hidden" name="unit_id" value="${escapeHtml(r.unitId)}">
          ${escapeHtml(r.roomId)}:${escapeHtml(r.unitId)}
        </td>
        <td>${escapeHtml(r.roomLabel || '—')}</td>
        <td>${r.count === null ? '<span class="small muted">今回は出てきません</span>' : `${r.count}件`}</td>
        <td><select name="unit_name" aria-label="${escapeHtml(r.roomId)}:${escapeHtml(r.unitId)} のユニット">${options}</select></td>
      </tr>`;
    })
    .join('');

  return `${discoverButton}
    <form method="post" action="/admin/beds24/map">
      <div class="scroll-x"><table>
        <tr><th>roomId:unitId</th><th>Beds24での名前</th><th>予約数</th><th>ユニット</th></tr>
        ${body}
      </table></div>
      <p class="small muted">「予約数」は、いま取得できる期間に入っている件数です。判断の手がかりにしてください。</p>
      <p class="sticky-save"><button type="submit" class="primary">対応づけを保存</button></p>
    </form>`;
}

/** 登録済みと発見結果を突き合わせる（キーは旧版と同じ 'roomId:unitId'） */
function mergeRows(existing, discovered) {
  const byKey = new Map();

  for (const row of discovered ?? []) {
    const key = `${row.roomId}:${row.unitId}`;
    byKey.set(key, {
      roomId: row.roomId,
      unitId: row.unitId,
      roomLabel: [row.roomName, row.unitName].filter(Boolean).join(' / '),
      count: row.count,
      unitName: ''
    });
  }

  for (const row of existing) {
    const key = `${row.roomId}:${row.unitId}`;
    const found = byKey.get(key);
    if (found) {
      found.unitName = row.unitName;
    } else {
      byKey.set(key, {
        roomId: row.roomId,
        unitId: row.unitId,
        roomLabel: '',
        count: null,
        unitName: row.unitName
      });
    }
  }

  return [...byKey.values()].sort((a, b) =>
    a.roomId === b.roomId ? a.unitId.localeCompare(b.unitId) : a.roomId.localeCompare(b.roomId)
  );
}

// ------------------------------------------------------------------
// 操作
// ------------------------------------------------------------------

export async function connectBeds24(request, env, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  if (!env.TOKEN_ENC_KEY) {
    return htmlResponse(
      await beds24Page(env, auth.user, { error: '秘密の鍵（TOKEN_ENC_KEY）が登録されていません。', now: options.now }),
      { status: 400 }
    );
  }

  const form = await readForm(request);
  const code = String(form.invite_code ?? '').trim();
  if (!code) {
    return htmlResponse(
      await beds24Page(env, auth.user, { error: '招待コードを入力してください。', now: options.now }),
      { status: 400 }
    );
  }

  try {
    await connectWithInviteCode(env.DB, env.TOKEN_ENC_KEY, code, overridesFrom(options));
  } catch (error) {
    return htmlResponse(
      await beds24Page(env, auth.user, { error: String(error?.message ?? error), now: options.now }),
      { status: 400 }
    );
  }

  return redirect('/admin/beds24?connected=1');
}

export async function discoverUnits(request, env, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  const fetchDays = (await getSetting(env.DB, 'fetch_days', 90)) || 90;
  const today = jstToday(options.now);

  try {
    const discovered = await discoverRoomIds(
      env.DB,
      env.TOKEN_ENC_KEY,
      { today, fetchDays },
      overridesFrom(options)
    );
    return htmlResponse(await beds24Page(env, auth.user, { discovered, now: options.now }));
  } catch (error) {
    return htmlResponse(
      await beds24Page(env, auth.user, { error: String(error?.message ?? error), now: options.now }),
      { status: 400 }
    );
  }
}

export async function saveUnitMap(request, env, options = {}) {
  const auth = await requireUser(request, env, { role: 'admin', at: options.at });
  if (auth.response) return auth.response;
  if (!checkOrigin(request)) return new Response('送信元を確認できませんでした。', { status: 403 });

  const form = await readForm(request);
  const roomIds = formList(form, 'room_id');
  const unitIds = formList(form, 'unit_id');
  const unitNames = formList(form, 'unit_name');

  // 存在するユニット名だけを受け付ける（「（使わない）」と不正な値はここで落ちる）
  const valid = new Set(await listUnitNames(env.DB));

  const rows = [];
  for (let i = 0; i < roomIds.length; i++) {
    const unitName = String(unitNames[i] ?? '').trim();
    if (!valid.has(unitName)) continue;
    rows.push({ roomId: String(roomIds[i]), unitId: String(unitIds[i] ?? ''), unitName });
  }

  await replaceUnitMap(env.DB, rows);
  return redirect('/admin/beds24?mapped=1');
}

export { STATE };
