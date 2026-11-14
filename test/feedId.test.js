import { describe, it, expect } from 'vitest';
import { generateFeedId } from '../src/lib/feedId.js';

// 生成結果は必ずサーバー側のスラッグ規則に合うこと。
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

describe('generateFeedId (実在フィードの例)', () => {
  it('Rebuild: ホスト名から rebuild', () => {
    const id = generateFeedId('https://feeds.rebuild.fm/rebuildfm', []);
    expect(id).toBe('rebuild');
    expect(id).toContain('rebuild');
  });
  it('COTEN RADIO (anchor.fm): チャンネル固有部分 8c2088c を残す', () => {
    const id = generateFeedId('https://anchor.fm/s/8c2088c/podcast/rss', []);
    expect(id).toBe('anchor-8c2088c');
    expect(id).toContain('8c2088c');
  });
  it('YouTube 疑似フィード: クエリは見ず youtube を含む', () => {
    const id = generateFeedId(
      'https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxxxxxxxxxxxxxxxxxxxx',
      []
    );
    expect(id).toBe('youtube-videos');
    expect(id).toContain('youtube');
  });
});

describe('generateFeedId (重なり回避)', () => {
  const url = 'https://feeds.rebuild.fm/rebuildfm';
  it('空きがあればそのまま', () => {
    expect(generateFeedId(url, ['other'])).toBe('rebuild');
    expect(generateFeedId(url, new Set(['other']))).toBe('rebuild');
  });
  it('重なれば -2、さらに重なれば -3', () => {
    expect(generateFeedId(url, ['rebuild'])).toBe('rebuild-2');
    expect(generateFeedId(url, ['rebuild', 'rebuild-2'])).toBe('rebuild-3');
  });
});

describe('generateFeedId (フォールバック)', () => {
  it('ノイズだけの URL は feed になる', () => {
    expect(generateFeedId('https://feed.rss/feed', [])).toBe('feed');
  });
  it('feed が埋まっていれば feed-2', () => {
    expect(generateFeedId('https://feed.rss/feed', ['feed'])).toBe('feed-2');
  });
  it('URL として解釈できない・空なら feed', () => {
    expect(generateFeedId('not-a-url', [])).toBe('feed');
    expect(generateFeedId('', [])).toBe('feed');
    expect(generateFeedId(null, null)).toBe('feed');
  });
});

describe('generateFeedId (長さと形の保証)', () => {
  it('長いホスト・パスでも64文字以内でスラッグに合う', () => {
    const url = `https://${'a'.repeat(30)}.example.com/${'b'.repeat(50)}`;
    const id = generateFeedId(url, []);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id).toMatch(SLUG_RE);
    expect(id.endsWith('-')).toBe(false);
  });
  it('厄介な URL の束でも常にスラッグ規則に合う', () => {
    const urls = [
      'https://EXAMPLE.com/Feed.XML',
      'https://example.com:8080/a/b',
      'https://192.168.0.1/feed',
      'https://example.com/%E3%83%86%E3%82%B9%E3%83%88',
      'https://example.com/',
      'https://example.com',
      'https://m.youtube.com/feeds/videos.xml?channel_id=UCx',
      'https://api.robotstart.jp/api/v1/feeds/35d00481/get-feeds/podcast',
      'https://www3.nhk.or.jp/rss/news/cat0.xml',
      'https://a.ze.gs/mfcf.xml',
      'https://sub.domain.example.co.jp/deep/path/to/feed.xml?x=1#frag',
    ];
    for (const url of urls) {
      const id = generateFeedId(url, []);
      expect(id, url).toMatch(SLUG_RE);
      expect(generateFeedId(url, [id]), url).toMatch(SLUG_RE);
    }
  });
});
