/* 清掃予定管理 — 画面の補助
 *
 * 画面はサーバー側で組み立てているので、ここは「あると少し楽になる」程度の処理だけ。
 * このファイルが読み込まれなくても、すべての機能は使えるようにしてある。
 */

/* 出勤入力の「まとめて入力」
 *
 * 1日ずつタップさせると30回以上の操作になり、入力が続かない。
 * よく使うパターンをボタン1つで埋められるようにする。
 * （このJSが動かなくても、1日ずつのタップで入力できる）
 */
document.addEventListener('click', (event) => {
  const button = event.target.closest('.bulk');
  if (!button) return;

  const value = button.dataset.value;
  const target = button.dataset.days;

  for (const row of document.querySelectorAll('.avail-row')) {
    if (row.classList.contains('past')) continue;

    const label = row.querySelector('.avail-date');
    const isWeekend = label && (label.classList.contains('sat') || label.classList.contains('sun'));
    if (target === 'weekday' && isWeekend) continue;

    const radio = row.querySelector(`input[type="radio"][value="${value}"]`);
    if (radio && !radio.disabled) {
      radio.checked = true;
      row.classList.remove('unset');
    }
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
