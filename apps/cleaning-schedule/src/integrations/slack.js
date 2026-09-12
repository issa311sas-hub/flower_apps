/**
 * Slack への通知（Incoming Webhook）
 *
 * 旧 GAS 版はエラーをログに書くだけで、実際に止まったとき誰も気づけなかった。
 * ここが「気づける」ようにするための最後の一手。
 *
 * 設計の要点:
 *   - **送信の失敗でジョブを止めない。** Slack が落ちていても清掃の割り当ては続ける
 *   - 送信の成否は notifications テーブルに残す。Slack が使えなくても管理画面で分かる
 *   - Webhook URL は「知っていれば誰でも投稿できる」ため、Beds24 トークンと同じ鍵で
 *     暗号化して保存し、画面には二度と表示しない
 */

import { encryptSecret, decryptSecret } from './crypto.js';
import { getSetting, setSetting } from '../db/settings.js';

export const WEBHOOK_KEY = 'notify_webhook_url';

const MARK = { error: '❗', warn: '⚠️', info: '✅' };

/** Slack の Incoming Webhook URL か、ざっと確かめる（打ち間違いをその場で弾く） */
export function looksLikeWebhookUrl(url) {
  return /^https:\/\/hooks\.slack\.com\/services\/\S+$/.test(String(url ?? '').trim());
}

export async function saveWebhookUrl(db, url, encKey, at = undefined) {
  const trimmed = String(url ?? '').trim();
  await setSetting(db, WEBHOOK_KEY, trimmed ? await encryptSecret(trimmed, encKey) : '', at);
}

export async function getWebhookUrl(db, encKey) {
  const stored = await getSetting(db, WEBHOOK_KEY, '');
  if (!stored) return null;

  try {
    return await decryptSecret(stored, encKey);
  } catch {
    // 鍵が変わった等。ここで例外を投げるとジョブごと止まるので、未設定として扱う
    return null;
  }
}

export async function hasWebhook(db) {
  return !!(await getSetting(db, WEBHOOK_KEY, ''));
}

/**
 * 1件送る。**例外は投げない。**
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function sendToSlack(webhookUrl, { level = 'info', subject, body, link = null }, overrides = {}) {
  const doFetch = overrides.fetch ?? globalThis.fetch.bind(globalThis);

  const text =
    `${MARK[level] ?? MARK.info} *${subject}*\n${body ?? ''}` +
    (link ? `\n<${link}|管理画面を開く>` : '');

  try {
    const res = await doFetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text })
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status} ${String(detail).slice(0, 200)}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 200) };
  }
}
