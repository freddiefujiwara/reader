import { describe, it, expect, vi } from 'vitest';
import {
  postJson,
  exchangeSession,
  exchangeShare,
  listArticles,
  listFeeds,
  saveFeed,
  deleteFeed,
  reorderFeeds,
} from '../src/lib/api.js';

const API = 'https://example.invalid/exec';

function okFetcher(payload) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }));
}

function lastBody(fetcher) {
  return JSON.parse(fetcher.mock.calls[0][1].body);
}

describe('postJson', () => {
  it('text/plain で JSON を POST し、ok 応答をそのまま返す', async () => {
    const fetcher = okFetcher({ ok: true, value: 1 });
    const data = await postJson({ action: 'list' }, { fetcher, apiUrl: API });
    expect(data).toEqual({ ok: true, value: 1 });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(API);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toContain('text/plain');
    expect(JSON.parse(init.body)).toEqual({ action: 'list' });
  });
  it('ok:false は error を投げる', async () => {
    const fetcher = okFetcher({ ok: false, error: 'unauthorized' });
    await expect(postJson({ action: 'list' }, { fetcher, apiUrl: API })).rejects.toThrow('unauthorized');
  });
  it('ネットワーク失敗 (TypeError) は1回だけ再試行する', async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new TypeError('Load failed');
      return { ok: true, status: 200, json: async () => ({ ok: true, value: 2 }) };
    });
    const data = await postJson({ action: 'list' }, { fetcher, apiUrl: API, retryDelayMs: 0 });
    expect(data).toEqual({ ok: true, value: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('API エラー (ok:false) は再試行しない', async () => {
    const fetcher = okFetcher({ ok: false, error: 'unauthorized' });
    await expect(postJson({ action: 'list' }, { fetcher, apiUrl: API, retryDelayMs: 0 })).rejects.toThrow('unauthorized');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('HTTP エラーはステータス付きで投げる', async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(postJson({ action: 'list' }, { fetcher, apiUrl: API })).rejects.toThrow('HTTP 500');
  });
  it('API URL 未設定なら api_not_configured', async () => {
    await expect(postJson({ action: 'list' }, { fetcher: okFetcher({}), apiUrl: '' })).rejects.toThrow('api_not_configured');
  });
  it('503 の後に成功したら2回目で回復する', async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ ok: true, value: 3 }) };
    });
    const data = await postJson({ action: 'list' }, { fetcher, apiUrl: API, retryDelayMs: 0 });
    expect(data).toEqual({ ok: true, value: 3 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('500 が続く場合は2回で諦めて投げる', async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(postJson({ action: 'list' }, { fetcher, apiUrl: API, retryDelayMs: 0 })).rejects.toThrow('HTTP 500');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('action の組み立て', () => {
  it('exchangeSession', async () => {
    const fetcher = okFetcher({ ok: true, sessionToken: 's', role: 'owner' });
    await exchangeSession('IDTOKEN', { fetcher, apiUrl: API });
    expect(lastBody(fetcher)).toEqual({ action: 'exchange_session', idToken: 'IDTOKEN' });
  });
  it('exchangeShare', async () => {
    const fetcher = okFetcher({ ok: true, sessionToken: 's', role: 'readonly' });
    await exchangeShare('SHARE', { fetcher, apiUrl: API });
    expect(lastBody(fetcher)).toEqual({ action: 'exchange_share', shareToken: 'SHARE' });
  });
  it('listArticles は既定で limit 50 / offset 0、feedId は任意', async () => {
    const fetcher = okFetcher({ ok: true, articles: [], feeds: [], total: 0 });
    await listArticles('tok', {}, { fetcher, apiUrl: API });
    expect(lastBody(fetcher)).toEqual({ action: 'list', sessionToken: 'tok', filter: 'all', limit: 50, offset: 0 });
    const fetcher2 = okFetcher({ ok: true, articles: [], feeds: [], total: 0 });
    await listArticles('tok', { feedId: 'nhk', filter: 'unread', limit: 50, offset: 50 }, { fetcher: fetcher2, apiUrl: API });
    expect(lastBody(fetcher2)).toEqual({ action: 'list', sessionToken: 'tok', filter: 'unread', limit: 50, offset: 50, feedId: 'nhk' });
  });
  it('listArticles は category を送れる', async () => {
    const fetcher = okFetcher({ ok: true, articles: [], feeds: [], total: 0 });
    await listArticles('tok', { category: '楽天' }, { fetcher, apiUrl: API });
    expect(lastBody(fetcher)).toEqual({ action: 'list', sessionToken: 'tok', filter: 'all', limit: 50, offset: 0, category: '楽天' });
  });
});

describe('フィード管理の action', () => {
  it('listFeeds', async () => {
    const feeds = [{ id: 'nhk', title: 'NHK', unreadCount: 2 }];
    const fetcher = okFetcher({ ok: true, feeds });
    const data = await listFeeds('tok', { fetcher, apiUrl: API });
    expect(data.feeds).toEqual(feeds);
    expect(lastBody(fetcher)).toEqual({ action: 'listFeeds', sessionToken: 'tok' });
  });
  it('saveFeed は feed をそのまま送り、応答の feed を返す', async () => {
    const feed = {
      id: 'nhk',
      title: 'NHKニュース',
      url: 'https://example.com/rss',
      category: 'news',
      enabled: true,
      isPrivate: false,
    };
    const fetcher = okFetcher({ ok: true, feed });
    const data = await saveFeed('tok', feed, { fetcher, apiUrl: API });
    expect(data.feed).toEqual(feed);
    expect(lastBody(fetcher)).toEqual({ action: 'saveFeed', sessionToken: 'tok', feed });
  });
  it('saveFeed の検証エラーは invalid で、serverMessage にサーバーの文言が入る', async () => {
    const fetcher = okFetcher({ ok: false, error: 'invalid', message: 'URLの形式が正しくありません' });
    const err = await saveFeed('tok', { id: 'x' }, { fetcher, apiUrl: API }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('invalid');
    expect(err.serverMessage).toBe('URLの形式が正しくありません');
  });
  it('deleteFeed', async () => {
    const fetcher = okFetcher({ ok: true });
    await deleteFeed('tok', 'nhk', { fetcher, apiUrl: API });
    expect(lastBody(fetcher)).toEqual({ action: 'deleteFeed', sessionToken: 'tok', feedId: 'nhk' });
  });
  it('deleteFeed の未知 id は not_found を投げる', async () => {
    const fetcher = okFetcher({ ok: false, error: 'not_found' });
    await expect(deleteFeed('tok', 'nope', { fetcher, apiUrl: API })).rejects.toThrow('not_found');
  });
  it('reorderFeeds', async () => {
    const fetcher = okFetcher({ ok: true });
    await reorderFeeds('tok', ['nhk', 'asahi'], { fetcher, apiUrl: API });
    expect(lastBody(fetcher)).toEqual({ action: 'reorderFeeds', sessionToken: 'tok', feedIds: ['nhk', 'asahi'] });
  });
});
