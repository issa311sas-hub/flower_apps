/**
 * 出勤入力のフォーム（本人用と管理者の代理入力で共有する）
 *
 * スタッフ本人は `/me/availability`、管理者は `/admin/availability/:staffId` から
 * **まったく同じ入力欄**を使う。違うのは「誰の分を書くか」と送信先だけ。
 *
 * ここに置いてあるのは画面の組み立てと受け取りの解釈だけで、
 * 誰の分を書いてよいかの判断（認可）は一切しない。それは呼ぶ側の責任。
 * 本人用の `staff.js` は「リクエストから staff_id を受け取らない」という
 * 決まりを持っているので、その決まりを壊さないよう分けてある。
 */

import { dayNameOf, dowOf } from '../core/dates.js';

export const CAPACITY_CHOICES = [0, 1, 2, 3, 4, 5];

/** 「消す」＝未入力に戻す。0件（出勤できない）とは意味が違う */
export const CLEAR_VALUE = -1;

const DOW_HEADS = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * 1日分のラジオボタン。
 *
 * カレンダーでも一覧でも**まったく同じ入力欄**を使う。
 * 送信されるのは `cap_YYYY-MM-DD` だけなので、保存処理は1つで済む。
 */
export function radiosFor(date, value, isPast, { hidden = false } = {}) {
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

/**
 * 入力フォームまるごと（HTML文字列）。
 *
 * @param {string} action 送信先。本人用と代理入力で変わる唯一の箇所
 */
export function availabilityForm({ days, current, today, month, view, action }) {
  const ctx = { days, current, today };

  return `<form method="post" action="${action}">
      <input type="hidden" name="month" value="${month}">
      <input type="hidden" name="view" value="${view}">

      <div class="presets small">
        まとめて入力:
        <button type="button" class="bulk" data-days="weekday" data-value="3">平日すべて3件</button>
        <button type="button" class="bulk" data-days="all" data-value="0">すべて0件</button>
      </div>

      ${view === 'calendar' ? calendarView(ctx) : listView(ctx)}

      <p class="sticky-save"><button type="submit" class="primary">この月をまとめて保存</button></p>
    </form>`;
}

/**
 * 送信されたフォームを解釈する。**誰の分かは見ない**（呼ぶ側が決める）。
 *
 * @returns {{month: string, view: string, entries: Array<{date: string, capacity: number}>, clears: string[]}}
 */
export function parseCapacityForm(form, today) {
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

  return {
    month: String(form.month ?? '').slice(0, 7),
    view: String(form.view ?? '') === 'list' ? 'list' : 'calendar',
    entries,
    clears
  };
}
