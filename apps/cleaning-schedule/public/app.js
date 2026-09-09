/* 清掃予定管理 — 画面の補助
 *
 * 画面はサーバー側で組み立てているので、ここは「あると少し楽になる」程度の処理だけ。
 * このファイルが読み込まれなくても、すべての機能は使えるようにしてある。
 */

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
