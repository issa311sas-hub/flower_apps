/**
 * Beds24 API V2 連携
 *
 * 旧 GAS 版（Code.gs:1630-2094）の移植。エンドポイントも取り込むフィールドも変えていない。
 *
 * 認証の流れ:
 *   招待コード → リフレッシュトークン（長期・使うたびにローテーション）
 *              → アクセストークン（24時間）
 *
 * 注意点:
 *   - リフレッシュトークンは**使うたびに新しいものが返る**。保存し損ねると次回401になる
 *   - 30日間使われないと失効する。日次の処理で毎日使うため通常は失効しない
 *   - 401/403 は失効（再接続が必要）、それ以外は一時的な障害として扱う
 */

import { addDays, nowIso } from '../core/dates.js';
import { getUnitLookup } from '../db/units.js';
import {
  getRefreshToken,
  getCachedAccessToken,
  saveTokens,
  recordAuthFailure
} from '../db/beds24Auth.js';

export const BEDS24_API_BASE = 'https://beds24.com/api/v2';

/** 1回の実行で取得するページ数の上限。
 *  無料プランはサブリクエストが50までのため、Beds24側の仕様変更で
 *  終了条件が壊れても暴走しないよう蓋をしておく。 */
const MAX_PAGES = 20;

/** ページ間の待ち時間（レート制限対策。旧版と同じ500ms） */
const PAGE_DELAY_MS = 500;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deps(overrides = {}) {
  return {
    fetch: overrides.fetch ?? globalThis.fetch.bind(globalThis),
    sleep: overrides.sleep ?? defaultSleep,
    now: overrides.now ?? (() => Date.now())
  };
}

class Beds24Error extends Error {
  constructor(message, { status = null, permanent = false } = {}) {
    super(message);
    this.name = 'Beds24Error';
    this.status = status;
    this.permanent = permanent;
  }
}

/** 401/403 は失効（再接続が必要）、それ以外は一時的な障害 */
const isPermanent = (status) => status === 401 || status === 403;

// ------------------------------------------------------------------
// 認証
// ------------------------------------------------------------------

/**
 * 招待コードをリフレッシュトークンに交換して保存する（初回接続）。
 * 招待コードの有効期限は24時間なので、発行したらすぐ使う必要がある。
 */
export async function connectWithInviteCode(db, encKey, inviteCode, overrides = {}) {
  const d = deps(overrides);
  const code = String(inviteCode || '').trim();
  if (!code) throw new Beds24Error('招待コードが入力されていません。');

  const res = await d.fetch(`${BEDS24_API_BASE}/authentication/setup`, {
    method: 'GET',
    headers: { code }
  });

  const at = nowIso(d.now());
  const body = await safeJson(res);
  if (!res.ok || !body?.refreshToken) {
    const message = body?.message || body?.error || `HTTP ${res.status}`;
    await recordAuthFailure(db, { permanent: isPermanent(res.status), error: message }, at);
    throw new Beds24Error(
      `接続に失敗しました: ${message}\n招待コードが正しいか、スコープに bookings と properties が含まれているか確認してください。`,
      { status: res.status, permanent: isPermanent(res.status) }
    );
  }

  await saveTokens(
    db,
    encKey,
    {
      refreshToken: body.refreshToken,
      accessToken: body.token ?? null,
      expiresInSec: body.expiresIn
    },
    at
  );

  return { connected: true };
}

/**
 * アクセストークンを取得する。期限内ならキャッシュを使う。
 *
 * @param {{force?: boolean}} options force=true でキャッシュを無視して必ず更新する
 *   （リフレッシュトークンの30日失効を防ぐキープアライブ用）
 */
export async function getAccessToken(db, encKey, options = {}, overrides = {}) {
  const d = deps(overrides);
  const force = options.force ?? false;

  if (!force) {
    const cached = await getCachedAccessToken(db, encKey, d.now());
    if (cached) return cached;
  }

  const refreshToken = await getRefreshToken(db, encKey);
  if (!refreshToken) {
    throw new Beds24Error('Beds24 に接続されていません。管理画面から招待コードを入力してください。', {
      permanent: true
    });
  }

  const res = await d.fetch(`${BEDS24_API_BASE}/authentication/token`, {
    method: 'GET',
    headers: { token: refreshToken }
  });

  const at = nowIso(d.now());

  if (!res.ok) {
    const detail = `HTTP ${res.status} ${await safeText(res)}`;
    await recordAuthFailure(db, { permanent: isPermanent(res.status), error: detail }, at);
    throw new Beds24Error(
      isPermanent(res.status)
        ? `Beds24 のトークンが失効しました。招待コードを再発行して接続し直してください。（${detail}）`
        : `Beds24 への接続に失敗しました。一時的な障害の可能性があります。（${detail}）`,
      { status: res.status, permanent: isPermanent(res.status) }
    );
  }

  const body = await safeJson(res);
  if (!body?.token) {
    const detail = 'トークンが返却されませんでした。';
    await recordAuthFailure(db, { permanent: false, error: detail }, at);
    throw new Beds24Error(detail);
  }

  // リフレッシュトークンもローテーションされるので、返ってきたら必ず保存する
  await saveTokens(
    db,
    encKey,
    {
      refreshToken: body.refreshToken ?? undefined,
      accessToken: body.token,
      expiresInSec: body.expiresIn
    },
    at
  );

  return body.token;
}

// ------------------------------------------------------------------
// 予約データの取得
// ------------------------------------------------------------------

/**
 * Beds24 の予約1件を、このアプリの形に変換する（純粋関数）。
 *
 * 旧版（Code.gs:1971-2000）と同じフィールドを見る。Beds24 の応答は
 * プランや設定で項目名が揺れるため、複数の候補を順に見るようになっている。
 *
 * @returns {object|null} 対象外（キャンセル・マッピング未設定など）なら null
 */
export function toAppBooking(row, unitLookup) {
  const status = String(row.status ?? '').toLowerCase();
  if (status === 'cancelled' || status === 'canceled' || status === 'deleted') {
    return { skipped: 'cancelled' };
  }

  const roomId = String(row.roomId ?? '');
  const unitId = String(row.unitId ?? '');
  const unit = unitLookup.get(`${roomId}:${unitId}`) ?? unitLookup.get(`${roomId}:`);
  if (!unit) return { skipped: 'unmapped', roomId, unitId };

  const bookingId = String(row.id ?? row.bookingId ?? '');
  if (!bookingId) return { skipped: 'no_id' };

  const startDate = normalizeDate(row.arrival ?? row.firstNight);
  let checkoutDate = normalizeDate(row.departure);
  if (!checkoutDate) {
    // departure がない場合は「最終宿泊日の翌日」がチェックアウト日
    const lastNight = normalizeDate(row.lastNight);
    checkoutDate = lastNight ? addDays(lastNight, 1) : null;
  }
  if (!checkoutDate) return { skipped: 'no_checkout', bookingId };

  const guests = (Number(row.numAdult) || 0) + (Number(row.numChild) || 0);

  return {
    booking: {
      bookingId,
      title: String(row.guestTitle ?? row.title ?? '').trim(),
      startDate,
      checkoutDate,
      unit,
      guests,
      rawRoomId: roomId,
      rawUnitId: unitId
    }
  };
}

function normalizeDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * 予約を取得してこのアプリの形で返す。
 *
 * @param {{today: string, fetchDays: number}} range 取得期間（チェックアウト日ベース）
 */
export async function fetchBookings(db, encKey, { today, fetchDays }, overrides = {}) {
  const d = deps(overrides);
  const token = await getAccessToken(db, encKey, {}, overrides);
  const unitLookup = await getUnitLookup(db);

  if (unitLookup.size === 0) {
    throw new Beds24Error(
      'ユニットマッピングが未設定です。管理画面で Beds24 の roomId とユニット名を対応付けてください。'
    );
  }

  const from = today;
  const to = addDays(today, fetchDays);

  const bookings = [];
  const skipped = { cancelled: 0, unmapped: 0, no_id: 0, no_checkout: 0 };
  const unmappedRooms = new Set();
  let page = 1;
  let pages = 0;

  while (page <= MAX_PAGES) {
    const url =
      `${BEDS24_API_BASE}/bookings?departure_from=${from}&departure_to=${to}` +
      `&includeInvoice=false&page=${page}`;

    const res = await d.fetch(url, { method: 'GET', headers: { token } });
    if (!res.ok) {
      throw new Beds24Error(`予約データの取得に失敗しました: HTTP ${res.status} ${await safeText(res)}`, {
        status: res.status,
        permanent: isPermanent(res.status)
      });
    }

    const body = await safeJson(res);
    const rows = Array.isArray(body) ? body : (body?.data ?? []);
    pages = page;

    for (const row of rows) {
      const result = toAppBooking(row, unitLookup);
      if (result.booking) {
        bookings.push(result.booking);
      } else {
        skipped[result.skipped] = (skipped[result.skipped] || 0) + 1;
        if (result.skipped === 'unmapped') unmappedRooms.add(`${result.roomId}:${result.unitId}`);
      }
    }

    // 空、または100件未満なら最後のページ（旧版と同じ判定）
    if (rows.length === 0 || rows.length < 100) break;

    page += 1;
    await d.sleep(PAGE_DELAY_MS);
  }

  return {
    bookings,
    pages,
    skipped,
    unmappedRooms: [...unmappedRooms],
    range: { from, to }
  };
}

/**
 * 予約データに出てくる roomId / unitId の一覧を返す（マッピング設定の補助）。
 * 旧版の「🔍 Beds24 roomId確認」メニューに相当する。
 */
export async function discoverRoomIds(db, encKey, { today, fetchDays = 90 }, overrides = {}) {
  const d = deps(overrides);
  const token = await getAccessToken(db, encKey, {}, overrides);

  const url =
    `${BEDS24_API_BASE}/bookings?departure_from=${today}&departure_to=${addDays(today, fetchDays)}` +
    `&includeInvoice=false&page=1`;

  const res = await d.fetch(url, { method: 'GET', headers: { token } });
  if (!res.ok) {
    throw new Beds24Error(`取得に失敗しました: HTTP ${res.status} ${await safeText(res)}`, {
      status: res.status,
      permanent: isPermanent(res.status)
    });
  }

  const body = await safeJson(res);
  const rows = Array.isArray(body) ? body : (body?.data ?? []);

  const combos = new Map();
  for (const row of rows) {
    const roomId = String(row.roomId ?? '');
    const unitId = String(row.unitId ?? '');
    const key = `${roomId}:${unitId}`;
    if (!combos.has(key)) {
      combos.set(key, {
        roomId,
        unitId,
        roomName: row.roomName ?? '',
        unitName: row.unitName ?? '',
        count: 0
      });
    }
    combos.get(key).count += 1;
  }

  return [...combos.values()].sort((a, b) => (a.roomId === b.roomId ? a.unitId.localeCompare(b.unitId) : a.roomId.localeCompare(b.roomId)));
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

export { Beds24Error };
