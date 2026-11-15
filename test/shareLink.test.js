import { describe, it, expect } from 'vitest';
import { buildShareUrl, formatShareExpiry } from '../src/lib/shareLink.js';

describe('buildShareUrl', () => {
  it('本番ベースで #share= を付ける', () => {
    expect(buildShareUrl('tok123', { origin: 'https://freddiefujiwara.com', base: '/reader/' }))
      .toBe('https://freddiefujiwara.com/reader/#share=tok123');
  });
  it('ステージングのベースでも同じ形になる', () => {
    expect(buildShareUrl('tok123', { origin: 'https://freddiefujiwara.com', base: '/reader/staging/' }))
      .toBe('https://freddiefujiwara.com/reader/staging/#share=tok123');
  });
  it('origin の末尾スラッシュと base のスラッシュ不足を吸収する', () => {
    expect(buildShareUrl('tok123', { origin: 'https://example.com/', base: '/reader' }))
      .toBe('https://example.com/reader/#share=tok123');
    expect(buildShareUrl('tok123', { origin: 'https://example.com', base: 'reader/' }))
      .toBe('https://example.com/reader/#share=tok123');
  });
  it('token が無ければ空文字', () => {
    expect(buildShareUrl('', { origin: 'https://example.com', base: '/reader/' })).toBe('');
    expect(buildShareUrl(null, { origin: 'https://example.com', base: '/reader/' })).toBe('');
  });
});

describe('formatShareExpiry', () => {
  it('ローカル時刻で 年/月/日 時:分 に整形する', () => {
    const iso = new Date(2026, 11, 16, 5, 47).toISOString();
    expect(formatShareExpiry(iso)).toBe('2026/12/16 5:47');
  });
  it('分はゼロ埋めする', () => {
    const iso = new Date(2027, 0, 3, 23, 5).toISOString();
    expect(formatShareExpiry(iso)).toBe('2027/1/3 23:05');
  });
  it('空・解釈できない値は空文字', () => {
    expect(formatShareExpiry('')).toBe('');
    expect(formatShareExpiry(null)).toBe('');
    expect(formatShareExpiry('not-a-date')).toBe('');
  });
});
