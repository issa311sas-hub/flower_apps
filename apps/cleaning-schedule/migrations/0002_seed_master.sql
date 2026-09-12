-- 初期データ
--
-- ユニット・担当者・既定の設定を投入する。
-- Beds24 の roomId マッピングとログインユーザーは、実環境ごとに異なるため
-- 管理画面から登録する（詳細は docs/setup-guide.md）。

-- ── ユニット（9棟）──────────────────────────────────
-- sort_order は旧版タイムラインの並び順（Code.gs:1374）に合わせている
INSERT INTO units (name, sort_order, label, is_active) VALUES
  ('b4', 1, NULL, 1),
  ('b5', 2, NULL, 1),
  ('b6', 3, NULL, 1),
  ('b2', 4, NULL, 1),
  ('b3', 5, NULL, 1),
  ('s1', 6, NULL, 1),
  ('s2', 7, NULL, 1),
  ('s3', 8, NULL, 1),
  ('c4', 9, NULL, 1);

-- ── 担当者 ────────────────────────────────────────────
-- default_capacity=0 は「カレンダー（現:Web）に件数の入力がない日は出勤不可」という
-- 旧版から引き継いだフェイルセーフ。誤って割り当てられることを防ぐ。
-- Rクリーンは uses_availability=0（旧版も外注側の上限は見ていない）。
INSERT INTO staff (name, short_name, kind, priority, default_capacity, uses_availability, color, is_active, created_at, updated_at) VALUES
  ('細田さん',   '細', 'staff',     1,  0, 1, '#E8F0FA', 1, '2026-09-08T00:00:00Z', '2026-09-08T00:00:00Z'),
  ('普久原さん', '普', 'staff',     2,  0, 1, '#FAF0E8', 1, '2026-09-08T00:00:00Z', '2026-09-08T00:00:00Z'),
  ('福田さん',   '福', 'staff',     3,  0, 1, '#E8FAE8', 1, '2026-09-08T00:00:00Z', '2026-09-08T00:00:00Z'),
  ('Rクリーン',  'R',  'outsource', 99, 99, 0, '#F0E8FA', 1, '2026-09-08T00:00:00Z', '2026-09-08T00:00:00Z');

-- ── 設定 ──────────────────────────────────────────────
INSERT INTO settings (key, value, updated_at) VALUES
  ('fetch_days',            '90',  '2026-09-08T00:00:00Z'),  -- Beds24から何日先まで取得するか
  ('outsource_window_days', '14',  '2026-09-08T00:00:00Z'),  -- この日数以内の未割当を外注に回す
  ('max_defer_days',        '2',   '2026-09-08T00:00:00Z'),  -- 清掃を延ばせる上限（害虫防止）
  ('stale_run_alert_days',  '3',   '2026-09-08T00:00:00Z'),  -- 何日成功しなければ警告するか
  ('notify_webhook_url',    '',    '2026-09-08T00:00:00Z'),  -- Slack の Incoming Webhook URL
  ('last_success_run_at',   '',    '2026-09-08T00:00:00Z');

-- ── Beds24 認証（1行だけ作っておく）──────────────────
INSERT INTO beds24_auth (id, state, updated_at) VALUES (1, '未接続', '2026-09-08T00:00:00Z');
