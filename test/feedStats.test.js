import { describe, it, expect } from 'vitest';
import { formatFeedUsage } from '../src/lib/feedStats.js';

const NOW = new Date('2026-11-25T03:00:00+09:00');

describe('formatFeedUsage', () => {
  it('記録が無いフィードは「直近90日の記録なし」', () => {
    expect(formatFeedUsage(undefined, NOW)).toBe('直近90日の記録なし');
    expect(formatFeedUsage(null, NOW)).toBe('直近90日の記録なし');
    expect(formatFeedUsage({ plays: 0, playSeconds: 0, opens: 0, expands: 0, views: 0, lastAt: '' }, NOW)).toBe('直近90日の記録なし');
  });

  it('再生は回数と累計時間（分・時間は丸める）', () => {
    expect(formatFeedUsage({ plays: 31, playSeconds: 238 * 60, opens: 0, expands: 0, views: 3, lastAt: '2026-11-24T10:00:00.000Z' }, NOW))
      .toBe('再生 31回（約3時間58分） ・ 表示 3回 ・ 最終 11/24');
    expect(formatFeedUsage({ plays: 2, playSeconds: 90, opens: 0, expands: 0, views: 0, lastAt: '' }, NOW))
      .toBe('再生 2回（約2分）');
    expect(formatFeedUsage({ plays: 1, playSeconds: 45, opens: 0, expands: 0, views: 0, lastAt: '' }, NOW))
      .toBe('再生 1回（45秒）');
    expect(formatFeedUsage({ plays: 3, playSeconds: 2 * 3600, opens: 0, expands: 0, views: 0, lastAt: '' }, NOW))
      .toBe('再生 3回（約2時間）');
  });

  it('開く・展開・表示は0のものを省く', () => {
    expect(formatFeedUsage({ plays: 0, playSeconds: 0, opens: 8, expands: 2, views: 0, lastAt: '2026-11-24T00:00:00.000Z' }, NOW))
      .toBe('開く 8回 ・ 展開 2回 ・ 最終 11/24');
  });

  it('最終活動日は年が違えば年も出す。読めない日付は省く', () => {
    expect(formatFeedUsage({ plays: 0, playSeconds: 0, opens: 1, expands: 0, views: 0, lastAt: '2025-12-31T00:00:00.000Z' }, NOW))
      .toBe('開く 1回 ・ 最終 2025/12/31');
    expect(formatFeedUsage({ plays: 0, playSeconds: 0, opens: 1, expands: 0, views: 0, lastAt: 'bad' }, NOW))
      .toBe('開く 1回');
  });
});
