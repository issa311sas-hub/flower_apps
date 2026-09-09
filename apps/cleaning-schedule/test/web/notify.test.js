/**
 * Slack 通知と死活監視のテスト
 *
 * 旧 GAS 版は静かに止まって誰も気づけなかった。ここはその再発防止そのものなので、
 * 「送れなかったときに何が起きるか」を重点的に確認する。
 * 通知が送れないことでジョブが止まっては本末転倒。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/index.js';
import { createTestDb } from '../support/d1-sqlite.js';
import { createUser } from '../../src/db/users.js';
import { recordNotification, listNotifications } from '../../src/db/notifications.js';
import { getSetting, setSetting } from '../../src/db/settings.js';
import { saveWebhookUrl, getWebhookUrl, looksLikeWebhookUrl } from '../../src/integrations/slack.js';
import { flushNotifications } from '../../src/jobs/notify.js';
import { saveSettings, testNotification, showSettings } from '../../src/web/pages/settings.js';

const ORIGIN = 'https://cleaning.example.workers.dev';
const PEPPER = 'test-pepper';
const ENC_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const FAST = { pepper: PEPPER, iterations: 1000 };
const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/xxxxxxxxxxxx';

let env;
let cookie;

beforeEach(async () => {
  env = { DB: createTestDb(), SESSION_PEPPER: PEPPER, TOKEN_ENC_KEY: ENC_KEY };
  const created = await createUser(
    env.DB,
    { loginId: 'owner', displayName: '経営者', role: 'admin', mustChange: false },
    FAST
  );
  const res = await worker.fetch(post('/login', { login_id: 'owner', password: created.password }), env);
  cookie = (res.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0];
});

function get(path, cookieValue = cookie) {
  return new Request(`${ORIGIN}${path}`, { headers: cookieValue ? { cookie: cookieValue } : {} });
}

function post(path, body, { cookie: cookieValue, origin = ORIGIN } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (cookieValue) headers.cookie = cookieValue;
  if (origin !== null) headers.origin = origin;
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body).toString()
  });
}

/** Slack の代わり。送られた内容を覚えておく */
function slackStub({ status = 200 } = {}) {
  const posts = [];
  const impl = async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (status >= 400 ? 'invalid_token' : 'ok'),
      json: async () => ({})
    };
  };
  impl.posts = posts;
  return impl;
}

describe('Webhook URL の保存', () => {
  it('暗号化して保存され、画面には二度と出ない', async () => {
    await saveWebhookUrl(env.DB, WEBHOOK, ENC_KEY);

    expect(await getWebhookUrl(env.DB, ENC_KEY)).toBe(WEBHOOK);

    const stored = await getSetting(env.DB, 'notify_webhook_url', '');
    expect(stored).not.toContain('hooks.slack.com');

    const body = await (await showSettings(get('/admin/settings'), env)).text();
    expect(body).not.toContain(WEBHOOK);
    expect(body).toContain('登録済み');
  });

  it('Slack のURLでなければ弾く（貼り間違いをその場で伝える）', async () => {
    expect(looksLikeWebhookUrl(WEBHOOK)).toBe(true);
    expect(looksLikeWebhookUrl('https://example.com/hook')).toBe(false);

    const res = await saveSettings(post('/admin/settings', { webhook_url: 'https://example.com/hook' }, { cookie }), env);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('hooks.slack.com');
    expect(await getSetting(env.DB, 'notify_webhook_url', '')).toBe('');
  });

  it('空で保存しても、登録済みのURLは消えない', async () => {
    await saveWebhookUrl(env.DB, WEBHOOK, ENC_KEY);
    await saveSettings(post('/admin/settings', { webhook_url: '', fetch_days: '90' }, { cookie }), env);

    expect(await getWebhookUrl(env.DB, ENC_KEY)).toBe(WEBHOOK);
  });

  it('鍵が変わっていても例外にせず、未設定として扱う（ジョブを止めない）', async () => {
    await saveWebhookUrl(env.DB, WEBHOOK, ENC_KEY);

    const otherKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    expect(await getWebhookUrl(env.DB, otherKey)).toBeNull();
  });
});

describe('通知の送信', () => {
  it('未送信の通知をまとめて送り、送信済みとして記録する', async () => {
    await saveWebhookUrl(env.DB, WEBHOOK, ENC_KEY);
    await setSetting(env.DB, 'app_base_url', ORIGIN);
    await recordNotification(env.DB, { kind: 'run_error', level: 'error', subject: '止まりました', body: '詳細' });

    const fetchImpl = slackStub();
    const result = await flushNotifications(env, { fetchImpl });

    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(fetchImpl.posts[0].url).toBe(WEBHOOK);
    expect(fetchImpl.posts[0].body.text).toContain('止まりました');
    expect(fetchImpl.posts[0].body.text).toContain('❗');
    expect(fetchImpl.posts[0].body.text).toContain(`${ORIGIN}/admin`);

    const [notification] = await listNotifications(env.DB);
    expect(notification.sent_at).toBeTruthy();
  });

  it('2回目は同じ通知を送り直さない', async () => {
    await saveWebhookUrl(env.DB, WEBHOOK, ENC_KEY);
    await recordNotification(env.DB, { kind: 'run_error', level: 'error', subject: 'x', body: 'y' });

    const fetchImpl = slackStub();
    await flushNotifications(env, { fetchImpl });
    await flushNotifications(env, { fetchImpl });

    expect(fetchImpl.posts).toHaveLength(1);
  });

  it('Slack が落ちていても例外にせず、次回に再送する', async () => {
    await saveWebhookUrl(env.DB, WEBHOOK, ENC_KEY);
    await recordNotification(env.DB, { kind: 'run_error', level: 'error', subject: 'x', body: 'y' });

    const failed = await flushNotifications(env, { fetchImpl: slackStub({ status: 500 }) });
    expect(failed).toMatchObject({ sent: 0, failed: 1 });

    // 失敗の理由は残るが、送信済みにはしない
    const [notification] = await listNotifications(env.DB);
    expect(notification.sent_at).toBeNull();
    expect(notification.send_error).toContain('500');

    const retried = await flushNotifications(env, { fetchImpl: slackStub() });
    expect(retried).toMatchObject({ sent: 1 });
  });

  it('未設定なら何もしない（エラーにしない）', async () => {
    await recordNotification(env.DB, { kind: 'run_error', level: 'error', subject: 'x', body: 'y' });
    expect(await flushNotifications(env, { fetchImpl: slackStub() })).toMatchObject({ skipped: 'no_webhook' });
  });

  it('後から設定しても、何日も前の警告は流れてこない', async () => {
    await saveWebhookUrl(env.DB, WEBHOOK, ENC_KEY);
    await recordNotification(
      env.DB,
      { kind: 'old', level: 'warn', subject: '古い警告', body: 'x' },
      { at: '2020-01-01T00:00:00.000Z' }
    );

    const fetchImpl = slackStub();
    expect(await flushNotifications(env, { fetchImpl })).toMatchObject({ sent: 0 });
    expect(fetchImpl.posts).toHaveLength(0);
  });
});

describe('テスト送信', () => {
  it('送信できたら記録に残るが、同じものが2回届かない', async () => {
    await saveWebhookUrl(env.DB, WEBHOOK, ENC_KEY);

    const fetchImpl = slackStub();
    const res = await testNotification(post('/admin/settings/test', {}, { cookie }), env, { fetchImpl });

    expect(await res.text()).toContain('Slack に送信しました');
    expect(fetchImpl.posts).toHaveLength(1);

    // 送信待ちの列には積まれない
    const again = await flushNotifications(env, { fetchImpl });
    expect(again).toMatchObject({ sent: 0 });
    expect(fetchImpl.posts).toHaveLength(1);
  });

  it('届かなければ理由を画面に出す', async () => {
    await saveWebhookUrl(env.DB, WEBHOOK, ENC_KEY);

    const res = await testNotification(post('/admin/settings/test', {}, { cookie }), env, {
      fetchImpl: slackStub({ status: 403 })
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('送信できませんでした');
  });
});

describe('死活監視（/api/health）', () => {
  it('正常なら 200 を返す', async () => {
    const res = await worker.fetch(get('/api/health'), env);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.problems).toEqual([]);
  });

  it('自動実行が滞っていたら 503 を返す（外部の監視で気づける）', async () => {
    await setSetting(env.DB, 'last_success_run_at', '2020-01-01T00:00:00.000Z');

    const res = await worker.fetch(get('/api/health'), env);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.problems.join()).toContain('自動実行');
  });

  it('Beds24 の再接続が必要なら 503 を返す', async () => {
    await env.DB.prepare("UPDATE beds24_auth SET state = '要再接続' WHERE id = 1").run();

    const res = await worker.fetch(get('/api/health'), env);
    expect(res.status).toBe(503);
    expect((await res.json()).problems.join()).toContain('Beds24');
  });

  it('まだ一度も実行していない状態は異常にしない（セットアップ中）', async () => {
    const res = await worker.fetch(get('/api/health'), env);
    expect(res.status).toBe(200);
  });
});

describe('アクセス制御', () => {
  it('スタッフは設定を変えられない', async () => {
    const { getStaffByName } = await import('../../src/db/staff.js');
    const staff = await getStaffByName(env.DB, '細田さん');
    const created = await createUser(
      env.DB,
      { loginId: 'hosoda', displayName: '細田さん', role: 'staff', staffId: staff.id, mustChange: false },
      FAST
    );
    const login = await worker.fetch(post('/login', { login_id: 'hosoda', password: created.password }), env);
    const sid = (login.headers.get('set-cookie') ?? '').match(/sid=[^;]+/)?.[0];

    const res = await worker.fetch(post('/admin/settings', { webhook_url: WEBHOOK }, { cookie: sid }), env);

    expect(res.headers.get('location')).toBe('/me');
    expect(await getSetting(env.DB, 'notify_webhook_url', '')).toBe('');
  });

  it('Origin の無いPOSTは拒否する', async () => {
    const res = await saveSettings(post('/admin/settings', { webhook_url: WEBHOOK }, { cookie, origin: null }), env);
    expect(res.status).toBe(403);
  });
});
