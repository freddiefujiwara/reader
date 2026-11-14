import { describe, it, expect } from 'vitest';
import { feedIdFromUrl, normalizeFeedIds } from '../src/lib/feedHash.js';

// フィードID = SHA-256(URL) の小文字 hex の先頭16文字。
// サーバー (reader-gas) と同じ値になることをベクトルで固定する。
describe('feedIdFromUrl', () => {
  it('Rebuild の URL', async () => {
    await expect(feedIdFromUrl('https://feeds.rebuild.fm/rebuildfm'))
      .resolves.toBe('b81e59da11f890d2');
  });
  it('COTEN RADIO (anchor.fm) の URL', async () => {
    await expect(feedIdFromUrl('https://anchor.fm/s/8c2088c/podcast/rss'))
      .resolves.toBe('87e6ebcd1afd6416');
  });
  it('常に16文字の小文字 hex で、URL が違えば ID も違う', async () => {
    const a = await feedIdFromUrl('https://example.com/a');
    const b = await feedIdFromUrl('https://example.com/b');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    // 同じ URL は常に同じ ID (前後の空白などは付けない、そのまま使う)。
    await expect(feedIdFromUrl('https://example.com/a')).resolves.toBe(a);
  });
});

describe('normalizeFeedIds', () => {
  it('ID を URL ハッシュへ付け替え、順序と他のフィールドはそのまま', async () => {
    const feeds = [
      { id: 'rebuild', title: 'Rebuild', url: 'https://feeds.rebuild.fm/rebuildfm', fetchUrl: 'https://x/rebuild' },
      { id: 'coten-radio', title: '', url: 'https://anchor.fm/s/8c2088c/podcast/rss', fetchUrl: 'https://x/coten' },
    ];
    const out = await normalizeFeedIds(feeds);
    expect(out.map((f) => f.id)).toEqual(['b81e59da11f890d2', '87e6ebcd1afd6416']);
    expect(out[0]).toEqual({ ...feeds[0], id: 'b81e59da11f890d2' });
    expect(out[1].fetchUrl).toBe('https://x/coten');
    // 元の配列・オブジェクトは変えない。
    expect(feeds[0].id).toBe('rebuild');
  });
  it('空・未定義でも空配列を返す', async () => {
    await expect(normalizeFeedIds([])).resolves.toEqual([]);
    await expect(normalizeFeedIds(undefined)).resolves.toEqual([]);
  });
});
