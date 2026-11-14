import { describe, it, expect, vi } from 'vitest';
import { proxyUrl, fetchFeedXml, fetchOneFeed, fetchAllFeeds, URL_FETCH_API_URL } from '../src/lib/feedFetch.js';

const XML = '<rss version="2.0"><channel><item><title>t1</title><link>https://example.com/1</link></item></channel></rss>';

function okFetcher(content = XML) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ url: 'x', content, error: null }) }));
}

describe('proxyUrl', () => {
  it('fetchUrl を u パラメータにエンコードする', () => {
    expect(proxyUrl('https://example.com/feed?a=1&b=2', 'https://proxy.invalid/exec'))
      .toBe('https://proxy.invalid/exec?u=https%3A%2F%2Fexample.com%2Ffeed%3Fa%3D1%26b%3D2');
  });
  it('既定のプロキシは url-fetch-gas の /exec', () => {
    expect(proxyUrl('https://example.com/f')).toContain(URL_FETCH_API_URL);
  });
});

describe('fetchFeedXml', () => {
  it('content を返す', async () => {
    await expect(fetchFeedXml('https://example.com/f', { fetcher: okFetcher() })).resolves.toBe(XML);
  });
  it('error が入っていたら投げる', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ url: 'x', content: null, error: 'HTTP 404' }) }));
    await expect(fetchFeedXml('https://example.com/f', { fetcher })).rejects.toThrow('HTTP 404');
  });
  it('HTTP エラーはステータス付きで投げ、再試行しない', async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(fetchFeedXml('https://example.com/f', { fetcher, retryDelayMs: 0 })).rejects.toThrow('HTTP 500');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('ネットワーク失敗 (TypeError) は1回だけ再試行する', async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new TypeError('Load failed');
      return { ok: true, status: 200, json: async () => ({ url: 'x', content: XML, error: null }) };
    });
    await expect(fetchFeedXml('https://example.com/f', { fetcher, retryDelayMs: 0 })).resolves.toBe(XML);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('fetchOneFeed / fetchAllFeeds', () => {
  const feeds = [
    { id: 'a', url: 'https://example.com/a.xml', fetchUrl: 'https://example.com/a.xml' },
    { id: 'b', url: 'https://example.com/b.xml' },
    { id: 'c', url: 'https://example.com/c.xml', fetchUrl: 'https://reader-gas.invalid/exec?rss=c' },
  ];
  function routerFetcher() {
    return vi.fn(async (url) => {
      const target = decodeURIComponent(url.split('?u=')[1]);
      if (target.includes('b.xml')) {
        return { ok: true, status: 200, json: async () => ({ url: target, content: null, error: 'boom' }) };
      }
      return { ok: true, status: 200, json: async () => ({ url: target, content: XML, error: null }) };
    });
  }
  it('fetchOneFeed は fetchUrl を優先し、エントリまで変換する', async () => {
    const result = await fetchOneFeed(feeds[2], { fetcher: routerFetcher() });
    expect(result.ok).toBe(true);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].title).toBe('t1');
  });
  it('失敗したフィードは ok:false で返り、他は入力順のまま', async () => {
    const results = await fetchAllFeeds(feeds, { fetcher: routerFetcher() });
    expect(results.map((r) => [r.feed.id, r.ok])).toEqual([['a', true], ['b', false], ['c', true]]);
    expect(results[1].entries).toEqual([]);
  });
  it('空のフィード一覧では空配列', async () => {
    await expect(fetchAllFeeds([], { fetcher: routerFetcher() })).resolves.toEqual([]);
  });
});
