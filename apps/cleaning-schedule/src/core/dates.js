/**
 * 日付ユーティリティ（JST前提）
 *
 * 【重要】このアプリでは「カレンダー上の1日」を必ず 'YYYY-MM-DD' の文字列で表す。
 *
 * 旧 GAS 版はスクリプトのタイムゾーン（JST）で Date を扱っていたが、
 * Cloudflare Workers は UTC で動く。ローカル日付として Date を組み立てると
 * 1日ずれるため、日付の演算はすべてこのモジュールに閉じ込める。
 *
 * - `new Date(y, m, d)` を使わない（ローカル解釈になる）
 * - Date への `setDate()` を使わない
 * - 日付文字列の大小比較はそのまま時系列順（ISO形式なので辞書順＝時系列順）
 *
 * 日本には夏時間がないため、UTC+9 の固定オフセットで厳密に正しい。
 */

const MS_PER_DAY = 86400000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

/** 'YYYY-MM-DD' 形式かどうか */
export function isYmd(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toUtcMs(ymd) {
  if (!isYmd(ymd)) throw new TypeError(`日付は 'YYYY-MM-DD' 形式で指定してください: ${ymd}`);
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const d = Number(ymd.slice(8, 10));
  return Date.UTC(y, m - 1, d);
}

function fromUtcMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** n日後（負数で n日前）の 'YYYY-MM-DD' */
export function addDays(ymd, n) {
  return fromUtcMs(toUtcMs(ymd) + n * MS_PER_DAY);
}

/** from から to までの日数（to - from） */
export function diffDays(from, to) {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / MS_PER_DAY);
}

/** 曜日番号（0=日 〜 6=土） */
export function dowOf(ymd) {
  return new Date(toUtcMs(ymd)).getUTCDay();
}

/** 曜日名（'月' など） */
export function dayNameOf(ymd) {
  return DAY_NAMES[dowOf(ymd)];
}

/** 実時刻から JST の「今日」を求める。ここだけが現在時刻に依存する */
export function jstToday(nowMs = Date.now()) {
  return new Date(nowMs + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 保存用のタイムスタンプ（UTC ISO-8601） */
export function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

/** from から days 日分の日付を並べた配列 */
export function rangeDays(from, days) {
  const out = [];
  for (let i = 0; i < days; i++) out.push(addDays(from, i));
  return out;
}

/** 旧 GAS 版の 'yyyy/MM/dd' を 'YYYY-MM-DD' に変換（移行データの取り込み用） */
export function fromLegacyDateStr(value) {
  const s = String(value).trim();
  const m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return isYmd(s) ? s : null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' を表示用の 'M/D(曜)' に変換 */
export function toDisplayDate(ymd) {
  const m = Number(ymd.slice(5, 7));
  const d = Number(ymd.slice(8, 10));
  return `${m}/${d}(${dayNameOf(ymd)})`;
}

// ------------------------------------------------------------------
// 月まわり（出勤入力の画面で使う）
// ------------------------------------------------------------------

/** 'YYYY-MM' の月に含まれる日付を並べた配列（月末の日数は自動で決まる） */
export function monthDays(month) {
  const days = [];
  let cursor = `${month}-01`;
  while (cursor.slice(0, 7) === month) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

/** 'YYYY-MM' を delta ヶ月ずらす（年またぎも扱う） */
export function shiftMonth(month, delta) {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) + delta;
  const y = year + Math.floor((m - 1) / 12);
  const mm = ((((m - 1) % 12) + 12) % 12) + 1;
  return `${y}-${String(mm).padStart(2, '0')}`;
}

/** 'YYYY-MM' を表示用の '2026年9月' に変換 */
export function monthLabel(month) {
  return `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`;
}

/**
 * URL の ?month=YYYY-MM を受け取る。形が違えば今月にする。
 *
 * 月表示の画面が5つあり、同じ判定をそれぞれが書いていた。
 * 1か所に寄せておかないと、受け付ける形を直したいときに取りこぼす。
 *
 * @param {string|null|undefined} value 受け取った値（未指定なら null）
 * @param {string} today 'YYYY-MM-DD'
 */
export function monthOr(value, today) {
  return /^\d{4}-\d{2}$/.test(String(value ?? '')) ? String(value) : today.slice(0, 7);
}
