/**
 * カレンダーの骨組み（月表示を作る3つの画面で共有する）
 *
 *   /me?view=calendar                  … スタッフ自身の清掃予定
 *   /me/availability                   … 出勤入力
 *   /admin/assignments?view=calendar   … 管理者が見る割り当て
 *
 * 3つとも「曜日の見出し → 月初まで空セル → 日ごとのセル」という同じ形で、
 * 違うのはセルの中身だけ。骨組みを別々に書いていたため、
 * 週の始まりや土日の色をどれか1つで直すと他とずれる状態だった。
 *
 * セルの中身は呼ぶ側が決める（`renderCell`）。ここは並べ方だけを持つ。
 */

import { dowOf } from '../core/dates.js';

const DOW_HEADS = ['日', '月', '火', '水', '木', '金', '土'];

/** 土日の色分け。表でもカレンダーでも同じ規則を使う */
export function weekendClass(date) {
  const dow = dowOf(date);
  return dow === 0 ? 'sun' : dow === 6 ? 'sat' : '';
}

/**
 * 月表示の格子を組み立てる。
 *
 * @param {string[]} days その月の日付（`monthDays` の戻り値）
 * @param {(date: string) => string} renderCell 1日分のセルのHTML
 * @param {{extraClass?: string}} options 格子そのものに足すクラス（'readonly' 等）
 */
export function calendarGrid(days, renderCell, { extraClass = '' } = {}) {
  const heads = DOW_HEADS.map(
    (name, i) => `<div class="cal-head ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${name}</div>`
  ).join('');

  // 月初の曜日まで空セルで埋める（1日が水曜なら先頭に3つ）
  const blanks = '<div class="cal-blank"></div>'.repeat(dowOf(days[0]));

  const cells = days.map(renderCell).join('');

  return `<div class="${['calendar', extraClass].filter(Boolean).join(' ')}">${heads}${blanks}${cells}</div>`;
}

/**
 * 1日分のセルに付けるクラスをまとめる。
 * 土日・過去・今日の扱いは3つの画面で同じにしたいので、ここに集約する。
 */
export function cellClasses(date, today, extra = []) {
  return [
    'cal-cell',
    weekendClass(date),
    date < today ? 'past' : '',
    date === today ? 'today' : '',
    ...extra
  ]
    .filter(Boolean)
    .join(' ');
}
