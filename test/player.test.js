import { describe, it, expect } from 'vitest';
import { formatTime, nextSpeed, clampSeek, progressRatio } from '../src/lib/player.js';

describe('formatTime', () => {
  it('1時間未満は M:SS', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(65)).toBe('1:05');
    expect(formatTime(3599)).toBe('59:59');
  });
  it('1時間以上は H:MM:SS', () => {
    expect(formatTime(3600)).toBe('1:00:00');
    expect(formatTime(3723)).toBe('1:02:03');
  });
  it('解釈できない値は 0:00', () => {
    expect(formatTime(Number.NaN)).toBe('0:00');
    expect(formatTime(-30)).toBe('0:00');
    expect(formatTime(Infinity)).toBe('0:00');
    expect(formatTime(undefined)).toBe('0:00');
  });
  it('端数は切り捨てる', () => {
    expect(formatTime(65.9)).toBe('1:05');
  });
});

describe('nextSpeed', () => {
  it('1 → 1.25 → 1.5 → 2 → 1 と循環する', () => {
    expect(nextSpeed(1)).toBe(1.25);
    expect(nextSpeed(1.25)).toBe(1.5);
    expect(nextSpeed(1.5)).toBe(2);
    expect(nextSpeed(2)).toBe(1);
  });
  it('未知の値は 1 に戻す', () => {
    expect(nextSpeed(3)).toBe(1);
  });
});

describe('clampSeek', () => {
  it('[0, duration] に丸める', () => {
    expect(clampSeek(-5, 100)).toBe(0);
    expect(clampSeek(50, 100)).toBe(50);
    expect(clampSeek(150, 100)).toBe(100);
  });
  it('duration が不明なら下限だけ守る', () => {
    expect(clampSeek(50, 0)).toBe(50);
    expect(clampSeek(-5, 0)).toBe(0);
    expect(clampSeek(50, Number.NaN)).toBe(50);
  });
});

describe('progressRatio', () => {
  it('割合を 0..1 で返す', () => {
    expect(progressRatio(30, 60)).toBe(0.5);
    expect(progressRatio(0, 60)).toBe(0);
    expect(progressRatio(90, 60)).toBe(1);
  });
  it('duration がゼロ・不明なら 0', () => {
    expect(progressRatio(10, 0)).toBe(0);
    expect(progressRatio(10, Number.NaN)).toBe(0);
  });
});
