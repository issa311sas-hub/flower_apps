/**
 * 適用するマイグレーションの一覧（順番どおり）
 *
 * Workers はまとめ読み込み（glob import）ができないので、ここに書き並べる。
 * **足したらここに1行足す。** 忘れると本番に反映されないため、
 * `test/db/migrate.test.js` で migrations/ の中身と一致しているかを検査している。
 */

import initSql from '../../migrations/0001_init.sql';
import seedSql from '../../migrations/0002_seed_master.sql';
import reportsSql from '../../migrations/0003_completion_reports.sql';
import checkinLimitSql from '../../migrations/0004_checkin_limit.sql';

export const MIGRATIONS = [
  { name: '0001_init.sql', sql: initSql },
  { name: '0002_seed_master.sql', sql: seedSql },
  { name: '0003_completion_reports.sql', sql: reportsSql },
  { name: '0004_checkin_limit.sql', sql: checkinLimitSql }
];
