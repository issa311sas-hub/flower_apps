/**
 * 対象外の判定（レビュー用のダミー予約）のテスト
 *
 * ダミー予約に清掃が割り当てられると、実在しない清掃がスタッフの予定に出て、
 * 外注にも回りうる。外注はそのまま費用になるので、ここは厳しく固定する。
 */

import { describe, it, expect } from 'vitest';
import { isExcludedTitle, splitExcluded, toExcludedAssignment, EXCLUDED_LABEL } from '../../src/core/exclude.js';

const booking = (bookingId, title, extra = {}) => ({
  bookingId,
  title,
  unit: 'b4',
  checkoutDate: '2026-09-15',
  guests: 2,
  ...extra
});

describe('タイトルの一致', () => {
  it('含まれていれば対象外', () => {
    expect(isExcludedTitle('【テスト】ダミー予約', ['テスト'])).toBe(true);
    expect(isExcludedTitle('ダミー予約（テスト用）', ['テスト'])).toBe(true);
  });

  it('含まれていなければ対象外にしない', () => {
    expect(isExcludedTitle('消毒ポット', ['テスト'])).toBe(false);
  });

  it('大文字小文字は区別しない', () => {
    expect(isExcludedTitle('TEST booking', ['test'])).toBe(true);
    expect(isExcludedTitle('test booking', ['TEST'])).toBe(true);
  });

  it('語句が複数あればどれか1つで対象外', () => {
    expect(isExcludedTitle('ダミー予約', ['テスト', 'ダミー'])).toBe(true);
  });

  it('タイトルが空なら対象外にしない', () => {
    expect(isExcludedTitle('', ['テスト'])).toBe(false);
    expect(isExcludedTitle(null, ['テスト'])).toBe(false);
  });

  it('空文字の語句では何も一致させない（全部消える事故を防ぐ）', () => {
    expect(isExcludedTitle('消毒ポット', [''])).toBe(false);
    expect(isExcludedTitle('消毒ポット', ['   '])).toBe(false);
  });
});

describe('予約の振り分け', () => {
  it('★語句が空なら1件も除外しない（既定の挙動を変えない）', () => {
    const bookings = [booking('1', 'テスト'), booking('2', '消毒ポット')];

    for (const words of [[], null, undefined, ['']]) {
      const { assignable, excluded } = splitExcluded(bookings, words);
      expect(assignable).toHaveLength(2);
      expect(excluded).toHaveLength(0);
    }
  });

  it('一致したものだけを分ける', () => {
    const { assignable, excluded } = splitExcluded(
      [booking('1', '【テスト】'), booking('2', '消毒ポット'), booking('3', 'テスト用')],
      ['テスト']
    );

    expect(excluded.map((b) => b.bookingId)).toEqual(['1', '3']);
    expect(assignable.map((b) => b.bookingId)).toEqual(['2']);
  });

  it('★手動で担当を決めた予約は、語句に一致しても除外しない', () => {
    const { assignable, excluded } = splitExcluded([booking('1', 'テスト')], ['テスト'], {
      existing: [{ bookingId: '1', isManual: true }]
    });

    expect(excluded).toHaveLength(0);
    expect(assignable.map((b) => b.bookingId)).toEqual(['1']);
  });

  it('自動で決まっていた予約は、あとから語句を足せば除外される', () => {
    const { excluded } = splitExcluded([booking('1', 'テスト')], ['テスト'], {
      existing: [{ bookingId: '1', isManual: false }]
    });

    expect(excluded).toHaveLength(1);
  });

  it('元の配列を書き換えない', () => {
    const bookings = [booking('1', 'テスト'), booking('2', '消毒ポット')];
    splitExcluded(bookings, ['テスト']);
    expect(bookings).toHaveLength(2);
  });
});

describe('対象外の割り当て行', () => {
  it('担当者名と状態が「対象外」になる', () => {
    const row = toExcludedAssignment(booking('1', 'テスト'));

    expect(row.staffName).toBe(EXCLUDED_LABEL);
    expect(row.status).toBe('対象外');
    expect(row.isManual).toBe(false);
  });

  it('清掃日はチェックアウト日のまま（そもそも清掃しないので延期しない）', () => {
    const row = toExcludedAssignment(booking('1', 'テスト', { checkoutDate: '2026-09-20' }));
    expect(row.cleaningDate).toBe('2026-09-20');
  });
});
