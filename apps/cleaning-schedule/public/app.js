/* 清掃予定管理 — 画面の補助
 *
 * 画面はサーバー側で組み立てているので、ここは「あると少し楽になる」程度の処理だけ。
 * このファイルが読み込まれなくても、すべての機能は使えるようにしてある。
 */

/* 出勤入力（カレンダー・一覧の共通処理）
 *
 * カレンダーと一覧のどちらも、1日ぶんのマス／行が data-day を持ち、
 * その中に同じラジオボタン（cap_YYYY-MM-DD）を隠し持っている。
 * ここでやるのは「どのラジオを選ぶか」だけなので、保存の仕組みは
 * 両方の画面で完全に同じになる。
 */

/** 1日ぶんの値を決める。表示も合わせて更新する */
function setDayValue(cell, value) {
  const radio = cell.querySelector(`input[type="radio"][value="${value}"]`);
  if (!radio || radio.disabled) return false;

  radio.checked = true;

  // カレンダーはマスに数字を出しているので、そちらも書き換える
  const shown = cell.querySelector('.cal-value');
  if (shown) shown.textContent = value === '-1' ? '' : value;

  cell.classList.toggle('unset', value === '-1');
  return true;
}

/* まとめて入力
 *
 * 1日ずつタップさせると30回以上の操作になり、入力が続かない。
 * よく使うパターンをボタン1つで埋められるようにする。
 */
document.addEventListener('click', (event) => {
  const button = event.target.closest('.bulk');
  if (!button) return;

  const value = button.dataset.value;
  const target = button.dataset.days;

  for (const cell of document.querySelectorAll('[data-day]')) {
    if (cell.dataset.past) continue;
    if (target === 'weekday' && cell.dataset.weekend) continue;
    setDayValue(cell, value);
  }
});

/* カレンダーのマスを押して件数を選ぶ
 *
 * マスごとにピッカーを置くと画面が埋まるので、共通のピッカーを1つだけ使う。
 * 選ぶ対象のマスは data-target に覚えておく。
 */
document.addEventListener('click', (event) => {
  const picker = document.getElementById('cal-picker');
  if (!picker) return;

  const cell = event.target.closest('.cal-cell');
  if (cell && !cell.dataset.past) {
    const date = cell.dataset.day;
    picker.dataset.target = date;
    picker.hidden = false;

    const label = picker.querySelector('.cal-picker-date');
    if (label) label.textContent = `${Number(date.slice(8, 10))}日 は何件できますか？`;

    for (const open of document.querySelectorAll('.cal-cell.open')) open.classList.remove('open');
    cell.classList.add('open');

    picker.scrollIntoView({ block: 'nearest' });
    return;
  }

  const pick = event.target.closest('.cal-picker .pick');
  if (pick) {
    const target = document.querySelector(`.cal-cell[data-day="${picker.dataset.target}"]`);
    if (target) setDayValue(target, pick.dataset.value);

    picker.hidden = true;
    for (const open of document.querySelectorAll('.cal-cell.open')) open.classList.remove('open');
    return;
  }

  // 関係ないところを押したら閉じる
  if (!picker.hidden && !event.target.closest('.cal-picker')) {
    picker.hidden = true;
    for (const open of document.querySelectorAll('.cal-cell.open')) open.classList.remove('open');
  }
});

/* 値のコピー */
document.addEventListener('click', async (event) => {
  const button = event.target.closest('.copy');
  if (!button) return;

  const input = document.getElementById(button.dataset.target);
  if (!input) return;

  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    // clipboard が使えない環境（古い端末・http接続など）では選択状態にする。
    // 利用者は Ctrl+C でコピーできる。
    input.select();
    button.textContent = '選択しました';
    setTimeout(() => (button.textContent = original), 2000);
    return;
  }

  button.textContent = 'コピーしました';
  setTimeout(() => (button.textContent = original), 2000);
});

/* 取り返しのつかない操作の確認
 *
 * data-confirm を持つ form は、送信前に一度確認する。
 * このJSが読み込まれなくても、押せば実行されるだけで壊れない。
 */
document.addEventListener('submit', (event) => {
  const message = event.target?.dataset?.confirm;
  if (message && !window.confirm(message)) event.preventDefault();
});
