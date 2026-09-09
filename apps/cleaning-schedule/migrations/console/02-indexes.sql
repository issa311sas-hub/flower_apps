CREATE INDEX idx_staff_priority ON staff(is_active, priority);

CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE INDEX idx_sessions_user    ON sessions(user_id);

CREATE INDEX idx_bookings_checkout   ON bookings(state, checkout_date);

CREATE INDEX idx_bookings_unit_start ON bookings(unit_name, start_date);

CREATE INDEX idx_assign_date       ON assignments(cleaning_date);

CREATE INDEX idx_assign_staff_date ON assignments(staff_name, cleaning_date);

CREATE INDEX idx_hist_booking ON assignment_history(booking_id, changed_at DESC);

CREATE INDEX idx_avail_date ON availability(date);

CREATE INDEX idx_runs_started ON runs(started_at DESC);

CREATE INDEX idx_notif_kind ON notifications(kind, created_at DESC);

CREATE INDEX idx_reports_staff_date ON completion_reports(staff_id, cleaning_date);

CREATE INDEX idx_reports_date ON completion_reports(cleaning_date);
