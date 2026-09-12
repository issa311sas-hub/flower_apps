CREATE TABLE staff (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL UNIQUE,          
  short_name        TEXT    NOT NULL,                 
  kind              TEXT    NOT NULL DEFAULT 'staff'
                            CHECK (kind IN ('staff','outsource')),
  priority          INTEGER NOT NULL,                 
  default_capacity  INTEGER NOT NULL DEFAULT 0,       
  uses_availability INTEGER NOT NULL DEFAULT 1,       
  color             TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);

CREATE TABLE users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name        TEXT NOT NULL,
  role                TEXT NOT NULL CHECK (role IN ('admin','staff')),
  staff_id            INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  password_iterations INTEGER NOT NULL,
  password_salt       TEXT NOT NULL,                  
  password_hash       TEXT NOT NULL,                  
  must_change         INTEGER NOT NULL DEFAULT 1,
  is_active           INTEGER NOT NULL DEFAULT 1,
  last_login_at       TEXT,
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,                      
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent   TEXT
);

CREATE TABLE units (
  name       TEXT PRIMARY KEY,                        
  sort_order INTEGER NOT NULL,                        
  label      TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  note       TEXT
);

CREATE TABLE unit_map (                               
  room_id   TEXT NOT NULL,
  unit_id   TEXT NOT NULL DEFAULT '',
  unit_name TEXT NOT NULL REFERENCES units(name) ON UPDATE CASCADE,
  note      TEXT,
  PRIMARY KEY (room_id, unit_id)
);

CREATE TABLE bookings (
  booking_id    TEXT PRIMARY KEY,
  title         TEXT NOT NULL DEFAULT '',             
  start_date    TEXT,                                 
  checkout_date TEXT NOT NULL,
  unit_name     TEXT NOT NULL,
  guests        INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'active'
                     CHECK (state IN ('active','cancelled')),
  raw_room_id   TEXT,
  raw_unit_id   TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,                        
  updated_at    TEXT NOT NULL
);

CREATE TABLE assignments (
  booking_id    TEXT PRIMARY KEY REFERENCES bookings(booking_id) ON DELETE CASCADE,
  checkout_date TEXT NOT NULL,
  cleaning_date TEXT NOT NULL,                        
  unit_name     TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  staff_name    TEXT NOT NULL,                        
  status        TEXT NOT NULL,                        
  next_guests   INTEGER NOT NULL DEFAULT 0,
  is_manual     INTEGER NOT NULL DEFAULT 0,           
  manual_by     INTEGER REFERENCES users(id),
  manual_at     TEXT,
  completed_at  TEXT,                                 
  completed_by  INTEGER REFERENCES users(id),
  last_run_id   INTEGER,
  updated_at    TEXT NOT NULL
);

CREATE TABLE assignment_history (                     
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  changed_by TEXT NOT NULL,                           
  run_id     INTEGER,
  old_staff  TEXT, new_staff  TEXT,
  old_date   TEXT, new_date   TEXT,
  old_status TEXT, new_status TEXT
);

CREATE TABLE availability (
  staff_id   INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  date       TEXT    NOT NULL,
  capacity   INTEGER NOT NULL CHECK (capacity BETWEEN 0 AND 9),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (staff_id, date)
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE beds24_auth (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token_enc TEXT,                             
  access_token_enc  TEXT,
  access_expires_at TEXT,
  last_ok_at        TEXT,                             
  state             TEXT NOT NULL DEFAULT '未接続',
  last_error        TEXT,
  updated_at        TEXT NOT NULL
);

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

CREATE TABLE notifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,                      
  level           TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  sent_at         TEXT,
  send_error      TEXT,
  acknowledged_at TEXT
);

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

CREATE TABLE report_answers (
  report_id  INTEGER NOT NULL REFERENCES completion_reports(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL CHECK (kind IN ('equipment','service')),
  label      TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (report_id, kind, label)
);
