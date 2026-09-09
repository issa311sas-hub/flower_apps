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

INSERT INTO staff (name, short_name, kind, priority, default_capacity, uses_availability, color, is_active, created_at, updated_at) VALUES
  ('細田さん',   '細', 'staff',     1,  0, 1, '#E8F0FA', 1, '2026-09-08T00:00:00Z', '2026-09-08T00:00:00Z'),
  ('普久原さん', '普', 'staff',     2,  0, 1, '#FAF0E8', 1, '2026-09-08T00:00:00Z', '2026-09-08T00:00:00Z'),
  ('福田さん',   '福', 'staff',     3,  0, 1, '#E8FAE8', 1, '2026-09-08T00:00:00Z', '2026-09-08T00:00:00Z'),
  ('Rクリーン',  'R',  'outsource', 99, 99, 0, '#F0E8FA', 1, '2026-09-08T00:00:00Z', '2026-09-08T00:00:00Z');

INSERT INTO settings (key, value, updated_at) VALUES
  ('fetch_days',            '90',  '2026-09-08T00:00:00Z'),  
  ('outsource_window_days', '14',  '2026-09-08T00:00:00Z'),  
  ('max_defer_days',        '2',   '2026-09-08T00:00:00Z'),  
  ('stale_run_alert_days',  '3',   '2026-09-08T00:00:00Z'),  
  ('notify_webhook_url',    '',    '2026-09-08T00:00:00Z'),  
  ('last_success_run_at',   '',    '2026-09-08T00:00:00Z');

INSERT INTO beds24_auth (id, state, updated_at) VALUES (1, '未接続', '2026-09-08T00:00:00Z');

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('report_equipment', 'FireStick
電気
エアコン
キッチンガス
お風呂のお湯
iPad', '2026-09-09T00:00:00Z'),
  ('report_services', 'バーベキュー
海遊び', '2026-09-09T00:00:00Z');
