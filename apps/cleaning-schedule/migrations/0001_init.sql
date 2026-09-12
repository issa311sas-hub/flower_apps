-- 清掃予定管理システム 初期スキーマ
--
-- 日付は 'YYYY-MM-DD'（JST のカレンダー日）、時刻は UTC の ISO-8601（末尾 Z）で保存する。
-- 旧 GAS 版の 'yyyy/MM/dd' 形式からは移行時に変換する。

-- ── 担当者マスタ ──────────────────────────────────────
CREATE TABLE staff (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL UNIQUE,          -- '細田さん'（割り当てロジックの識別子）
  short_name        TEXT    NOT NULL,                 -- '細'（タイムライン表示用）
  kind              TEXT    NOT NULL DEFAULT 'staff'
                            CHECK (kind IN ('staff','outsource')),
  priority          INTEGER NOT NULL,                 -- 1,2,3 … 99=Rクリーン
  default_capacity  INTEGER NOT NULL DEFAULT 0,       -- 未入力日の上限（0=出勤不可のフェイルセーフ）
  uses_availability INTEGER NOT NULL DEFAULT 1,       -- Rクリーンは0（旧版も上限を見ていない）
  color             TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);
CREATE INDEX idx_staff_priority ON staff(is_active, priority);

-- ── ログインユーザー ──────────────────────────────────
CREATE TABLE users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name        TEXT NOT NULL,
  role                TEXT NOT NULL CHECK (role IN ('admin','staff')),
  staff_id            INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  password_iterations INTEGER NOT NULL,
  password_salt       TEXT NOT NULL,                  -- base64
  password_hash       TEXT NOT NULL,                  -- base64 (PBKDF2-SHA256)
  must_change         INTEGER NOT NULL DEFAULT 1,
  is_active           INTEGER NOT NULL DEFAULT 1,
  last_login_at       TEXT,
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,                      -- sha256(token || PEPPER)。生トークンはCookieのみ
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent   TEXT
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_sessions_user    ON sessions(user_id);

-- ── ユニットと Beds24 マッピング ──────────────────────
CREATE TABLE units (
  name       TEXT PRIMARY KEY,                        -- 'b2'
  sort_order INTEGER NOT NULL,                        -- タイムラインの並び順
  label      TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  note       TEXT
);

CREATE TABLE unit_map (                               -- 旧 設定シート A21:D
  room_id   TEXT NOT NULL,
  unit_id   TEXT NOT NULL DEFAULT '',
  unit_name TEXT NOT NULL REFERENCES units(name) ON UPDATE CASCADE,
  note      TEXT,
  PRIMARY KEY (room_id, unit_id)
);

-- ── 予約（旧 予約データシート）────────────────────────
CREATE TABLE bookings (
  booking_id    TEXT PRIMARY KEY,
  title         TEXT NOT NULL DEFAULT '',             -- 特殊要望（消毒ポット等）
  start_date    TEXT,                                 -- チェックイン日。不明な場合あり
  checkout_date TEXT NOT NULL,
  unit_name     TEXT NOT NULL,
  guests        INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'active'
                     CHECK (state IN ('active','cancelled')),
  raw_room_id   TEXT,
  raw_unit_id   TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,                        -- 最後に Beds24 応答に現れた時刻
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_bookings_checkout   ON bookings(state, checkout_date);
CREATE INDEX idx_bookings_unit_start ON bookings(unit_name, start_date);

-- ── 割り当て（旧 割り当て結果＋同期データベース）──────
CREATE TABLE assignments (
  booking_id    TEXT PRIMARY KEY REFERENCES bookings(booking_id) ON DELETE CASCADE,
  checkout_date TEXT NOT NULL,
  cleaning_date TEXT NOT NULL,                        -- 翌日・翌々日に延期されることがある
  unit_name     TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  staff_name    TEXT NOT NULL,                        -- 担当 or '未割当'
  status        TEXT NOT NULL,                        -- 確定 / 確定（翌日）/ 外注 / 要確認
  next_guests   INTEGER NOT NULL DEFAULT 0,
  is_manual     INTEGER NOT NULL DEFAULT 0,           -- 管理者の手動変更（自動割り当てで動かさない）
  manual_by     INTEGER REFERENCES users(id),
  manual_at     TEXT,
  completed_at  TEXT,                                 -- スタッフの完了報告
  completed_by  INTEGER REFERENCES users(id),
  last_run_id   INTEGER,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_assign_date       ON assignments(cleaning_date);
CREATE INDEX idx_assign_staff_date ON assignments(staff_name, cleaning_date);

CREATE TABLE assignment_history (                     -- カレンダーの編集履歴の代替
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  changed_by TEXT NOT NULL,                           -- 'cron' | 'admin:<login_id>'
  run_id     INTEGER,
  old_staff  TEXT, new_staff  TEXT,
  old_date   TEXT, new_date   TEXT,
  old_status TEXT, new_status TEXT
);
CREATE INDEX idx_hist_booking ON assignment_history(booking_id, changed_at DESC);

-- ── 出勤可能件数（Googleカレンダーの置き換え）─────────
CREATE TABLE availability (
  staff_id   INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  date       TEXT    NOT NULL,
  capacity   INTEGER NOT NULL CHECK (capacity BETWEEN 0 AND 9),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (staff_id, date)
);
CREATE INDEX idx_avail_date ON availability(date);

-- ── 設定（旧 設定シート）──────────────────────────────
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ── Beds24 認証（1行のみ）─────────────────────────────
CREATE TABLE beds24_auth (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token_enc TEXT,                             -- AES-GCM で暗号化して保存
  access_token_enc  TEXT,
  access_expires_at TEXT,
  last_ok_at        TEXT,                             -- 30日失効の起点
  state             TEXT NOT NULL DEFAULT '未接続',
  last_error        TEXT,
  updated_at        TEXT NOT NULL
);

-- ── 実行ログ ──────────────────────────────────────────
CREATE TABLE runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL CHECK (kind IN ('cron','manual','keepalive')),
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  ok           INTEGER,
  fetched      INTEGER,
  assigned     INTEGER,
  confirmed    INTEGER,
  deferred     INTEGER,
  outsourced   INTEGER,
  unassigned   INTEGER,
  message      TEXT,
  error        TEXT,
  triggered_by TEXT
);
CREATE INDEX idx_runs_started ON runs(started_at DESC);

-- ── 通知（送信ログ＋スロットル＋画面バナーの元）───────
CREATE TABLE notifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,                      -- auth_expired / run_error / unassigned …
  level           TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  sent_at         TEXT,
  send_error      TEXT,
  acknowledged_at TEXT
);
CREATE INDEX idx_notif_kind ON notifications(kind, created_at DESC);
