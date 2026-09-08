/**
 * 日付ユーティリティのテスト
 *
 * Cloudflare Workers は UTC で動くため、JST とのずれで清掃日が1日ずれる事故が起きやすい。
 * ここで境界を固定しておく。
 */

import { describe, it, expect } from 'vitest';
import { addDays, diffDays, dowOf, dayNameOf, jstToday, rangeDays, fromLegacyDateStr, toDisplayDate } from '../../src/core/dates.js';

describe('日付の加減算', () => {
  it('月をまたいでも正しい', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
  });

  it('年をまたいでも正しい', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('うるう年を正しく扱う', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('日数の差を求められる', () => {
    expect(diffDays('2026-09-08', '2026-09-22')).toBe(14);
    expect(diffDays('2026-09-22', '2026-09-08')).toBe(-14);
  });

  it("'YYYY-MM-DD' 以外は受け付けない", () => {
    expect(() => addDays('2026/09/08', 1)).toThrow();
  });
});

describe('曜日', () => {
  it('2026-09-08 は火曜', () => {
    expect(dowOf('2026-09-08')).toBe(2);
    expect(dayNameOf('2026-09-08')).toBe('火');
  });

  it('日曜は0', () => {
    expect(dowOf('2026-09-13')).toBe(0);
    expect(dayNameOf('2026-09-13')).toBe('日');
  });
});

describe('JST の「今日」', () => {
  it('UTC 21:00 は翌日の JST になる（cron の実行時刻）', () => {
    expect(jstToday(Date.parse('2026-09-08T21:05:00Z'))).toBe('2026-09-09');
  });

  it('UTC 14:59 はまだ同じ日', () => {
    expect(jstToday(Date.parse('2026-09-08T14:59:00Z'))).toBe('2026-09-08');
  });

  it('UTC 15:00 ちょうどで日付が変わる（JST 00:00）', () => {
    expect(jstToday(Date.parse('2026-09-08T15:00:00Z'))).toBe('2026-09-09');
  });
});

describe('その他', () => {
  it('日付の並びを作れる', () => {
    expect(rangeDays('2026-09-08', 3)).toEqual(['2026-09-08', '2026-09-09', '2026-09-10']);
  });

  it("旧版の 'yyyy/MM/dd' を変換できる", () => {
    expect(fromLegacyDateStr('2026/09/08')).toBe('2026-09-08');
    expect(fromLegacyDateStr('2026/9/8')).toBe('2026-09-08');
  });

  it('表示用の形式に変換できる', () => {
    expect(toDisplayDate('2026-09-08')).toBe('9/8(火)');
  });
});
