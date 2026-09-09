-- 清掃完了報告
--
-- 旧運用ではメッセージで送ってもらっていた内容（使用状況・設備の確認・
-- 追加サービス・現地精算金額）を、アプリの入力として記録する。
--
-- ★現地精算金額は「お客さんが現地に置いていった現金を清掃員が回収した額」で、
--   事実上の給与の前払い。あとで給与から差し引くため、月ごと・清掃員ごとに集計する。

-- ── 報告本体 ────────────────────────────────────────
-- ⚠ booking_id に外部キーを張らない。
--    assignments は bookings(booking_id) ON DELETE CASCADE で、
--    saveAssignments は取得結果から消えた予約の行を削除する。
--    予約がキャンセルされたときに金額の記録まで消えるのは論外なので、
--    日付・ユニット・担当者名・金額はこの表に自前で持つ。
CREATE TABLE completion_reports (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id     TEXT    NOT NULL UNIQUE,
  cleaning_date  TEXT    NOT NULL,
  unit_name      TEXT    NOT NULL,
  staff_id       INTEGER NOT NULL REFERENCES staff(id),
  staff_name     TEXT    NOT NULL,
  condition      TEXT    NOT NULL CHECK (condition IN ('A','B','C','F')),
  settlement_yen INTEGER NOT NULL DEFAULT 0,
  note           TEXT,
  reported_by    INTEGER REFERENCES users(id),
  reported_at    TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE INDEX idx_reports_staff_date ON completion_reports(staff_id, cleaning_date);
CREATE INDEX idx_reports_date ON completion_reports(cleaning_date);

-- ── 各項目の回答 ────────────────────────────────────
--   equipment … ok / ng
--   service   … none / cleaned / not_cleaned
-- 項目名（label）は settings の report_equipment / report_services で変えられる。
-- 過去の報告は当時の項目名のまま残す（あとから項目を変えても履歴が壊れない）。
CREATE TABLE report_answers (
  report_id  INTEGER NOT NULL REFERENCES completion_reports(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL CHECK (kind IN ('equipment','service')),
  label      TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (report_id, kind, label)
);

-- ── 報告フォームに出す項目（1行1項目）────────────────
INSERT INTO settings (key, value, updated_at) VALUES
  ('report_equipment', 'FireStick
電気
エアコン
キッチンガス
お風呂のお湯
iPad', '2026-09-09T00:00:00Z'),
  ('report_services', 'バーベキュー
海遊び', '2026-09-09T00:00:00Z');
