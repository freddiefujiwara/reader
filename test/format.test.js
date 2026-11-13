import { describe, it, expect } from 'vitest';
import { formatPublishedAt } from '../src/lib/format.js';

// 基準: 2026-11-14 (土) 12:00 ローカル時刻。
const NOW = new Date(2026, 10, 14, 12, 0, 0);
const isoLocal = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi).toISOString();

describe('formatPublishedAt', () => {
  it('今日の記事は「今日 H:MM」', () => {
    expect(formatPublishedAt(isoLocal(2026, 10, 14, 7, 5), NOW)).toBe('今日 7:05');
    expect(formatPublishedAt(isoLocal(2026, 10, 14, 23, 59), NOW)).toBe('今日 23:59');
  });
  it('昨日の記事は「昨日 H:MM」', () => {
    expect(formatPublishedAt(isoLocal(2026, 10, 13, 7, 5), NOW)).toBe('昨日 7:05');
  });
  it('月をまたいだ昨日も正しく判定する', () => {
    const now = new Date(2026, 10, 1, 9, 0);
    expect(formatPublishedAt(isoLocal(2026, 9, 31, 22, 30), now)).toBe('昨日 22:30');
  });
  it('同年の古い記事は「M/D」', () => {
    expect(formatPublishedAt(isoLocal(2026, 10, 13, 0, 0), new Date(2026, 10, 20, 12, 0))).toBe('11/13');
    expect(formatPublishedAt(isoLocal(2026, 0, 3, 15, 0), NOW)).toBe('1/3');
  });
  it('前年以前は「YYYY/M/D」', () => {
    expect(formatPublishedAt(isoLocal(2025, 11, 3, 15, 0), NOW)).toBe('2025/12/3');
  });
  it('空・不正な値は空文字', () => {
    expect(formatPublishedAt('', NOW)).toBe('');
    expect(formatPublishedAt(null, NOW)).toBe('');
    expect(formatPublishedAt('not-a-date', NOW)).toBe('');
  });
});
