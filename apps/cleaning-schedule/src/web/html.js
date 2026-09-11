/**
 * 画面の共通部品
 *
 * テンプレートエンジンは使わない。画面数が少なく、
 * 依存を増やすほどの利点がないため、素のテンプレート文字列で組み立てる。
 * ただし**エスケープは必ず通す**（利用者が入力した文字がそのまま出る箇所があるため）。
 */

export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/** 値を埋め込むときは自動でエスケープするタグ付きテンプレート */
export function html(strings, ...values) {
  return strings.reduce((out, str, i) => {
    if (i === 0) return str;
    const value = values[i - 1];
    // 配列は連結する（行の繰り返し用）。raw() を通したものはそのまま出す
    const rendered = Array.isArray(value)
      ? value.map((v) => (v?.__raw ? v.value : escapeHtml(v))).join('')
      : value?.__raw
        ? value.value
        : escapeHtml(value);
    return out + rendered + str;
  }, '');
}

/** すでに組み立て済みのHTMLを、エスケープせずに埋め込む */
export function raw(value) {
  return { __raw: true, value: String(value ?? '') };
}

/**
 * ナビの行き先は**役割で変える**。
 *
 * `/me` と `/me/availability` はログイン中の本人の担当分を出す画面なので、
 * 担当者に紐づいていない管理者が開いても「担当者の割り当てがありません」に
 * なるだけで、何もできない。以前は役割にかかわらずここへ送っていたため、
 * 管理者はナビから出勤入力にたどり着けなかった。
 *
 * 管理者が担当者も兼ねている場合（`staffId` がある）だけ、本人用の入口も出す。
 */
function tabsFor(user) {
  const links =
    user.role === 'admin'
      ? [
          ['/admin', '管理'],
          ['/admin/assignments', '予定'],
          ['/admin/availability', '出勤入力'],
          ...(user.staffId ? [['/me', '自分の予定']] : [])
        ]
      : [
          ['/me', '予定'],
          // 外注（Rクリーン）は出勤入力を使わない。割り当てエンジンは外注の
          // 入力を読まない（assign.js は workers にも外注を入れない）ので、
          // 出しても入れた本人には何も起きず、混乱するだけになる。
          ...(user.usesAvailability === false ? [] : [['/me/availability', '出勤入力']])
        ];

  return links.map(([href, label]) => `<a href="${href}">${label}</a>`).join('\n           ');
}

/**
 * 共通のHTML枠
 * @param {{title: string, user?: object, body: string, nav?: boolean}} options
 */
export function page({ title, user = null, body, nav = true }) {
  const navBar = nav && user ? `<nav class="tabs">${tabsFor(user)}
           <form method="post" action="/logout" class="inline">
             <button type="submit" class="link">ログアウト</button>
           </form>
         </nav>` : '';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>清掃予定管理 - ${escapeHtml(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#1f6feb">
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<header class="bar">
  <h1>清掃予定管理</h1>
  ${user ? `<span class="small muted">${escapeHtml(user.displayName)}</span>` : `<span class="badge">${escapeHtml(title)}</span>`}
</header>
${navBar}
<div class="wrap">
${body}
</div>
</body>
</html>`;
}

export function htmlResponse(body, init = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...(init.headers ?? {}) }
  });
}

export function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers ?? {}) }
  });
}

/** 更新後は必ずリダイレクトする（再読み込みで二重送信されないように） */
export function redirect(location, init = {}) {
  return new Response(null, {
    status: init.status ?? 303,
    headers: { location, ...(init.headers ?? {}) }
  });
}
