/**
 * 通知の送信（Slack）
 *
 * 記録（notifications テーブル）と送信を分けている。
 *   1. ジョブは「気づいてほしいこと」を記録するだけ
 *   2. このジョブが、まだ送れていないものをまとめて送る
 *
 * こうしておくと、Slack が落ちていても清掃の割り当ては止まらず、
 * 復旧したときに自動で送り直される。管理画面には最初から出ている。
 */

import { nowIso } from '../core/dates.js';
import { listUnsent, markSent } from '../db/notifications.js';
import { getSetting } from '../db/settings.js';
import { getWebhookUrl, sendToSlack } from '../integrations/slack.js';

export async function flushNotifications(env, options = {}) {
  const db = env.DB;
  const nowMs = options.now ?? Date.now();
  const at = nowIso(nowMs);

  const webhook = await getWebhookUrl(db, env.TOKEN_ENC_KEY);
  if (!webhook) return { skipped: 'no_webhook', sent: 0, failed: 0 };

  const pending = await listUnsent(db, { limit: options.limit ?? 10, at });
  if (pending.length === 0) return { sent: 0, failed: 0 };

  const base = String((await getSetting(db, 'app_base_url', '')) || '').replace(/\/$/, '');
  const link = base ? `${base}/admin` : null;

  let sent = 0;
  let failed = 0;

  for (const notification of pending) {
    const result = await sendToSlack(
      webhook,
      {
        level: notification.level,
        subject: notification.subject,
        body: notification.body,
        link
      },
      { fetch: options.fetchImpl }
    );

    await markSent(db, notification.id, { error: result.ok ? null : result.error, at });
    if (result.ok) sent += 1;
    else failed += 1;
  }

  return { sent, failed, pending: pending.length };
}
