import { describe, it, expect, vi } from 'vitest';
import {
  postJson,
  exchangeSession,
  exchangeShare,
  listArticles,
  listFeeds,
  saveFeed,
  deleteFeed,
  setStar,
  reorderFeeds,
  issueShareLink,
  getShareLinkStatus,
  getFeedStats,
  revokeShareLink,
  logEvents,
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
  it('応答が固まったらタイムアウトで打ち切り、再試行しない', async () => {
    // fetch が abort シグナルで AbortError を返す振る舞いを模す。
    const fetcher = vi.fn((url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        reject(e);
      });
    }));
    await expect(postJson({ action: 'list' }, { fetcher, apiUrl: API, timeoutMs: 10, retryDelayMs: 0 }))
      .rejects.toThrow('aborted');
    expect(fetcher).toHaveBeenCalledTimes(1);
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
  it('setStar は set_star に id と on を送る', async () => {
    const fetcher = okFetcher({ ok: true });
    await setStar('tok', 'article-1', true, { fetcher, apiUrl: API });
    expect(lastBody(fetcher)).toEqual({ action: 'set_star', sessionToken: 'tok', id: 'article-1', on: true });
    const fetcher2 = okFetcher({ ok: true });
    await setStar('tok', 'article-1', false, { fetcher: fetcher2, apiUrl: API });
    expect(lastBody(fetcher2)).toEqual({ action: 'set_star', sessionToken: 'tok', id: 'article-1', on: false });
  });
  it('setStar の forbidden はそのまま投げる (readonly 用)', async () => {
    const fetcher = okFetcher({ ok: false, error: 'forbidden' });
    await expect(setStar('tok', 'article-1', true, { fetcher, apiUrl: API })).rejects.toThrow('forbidden');
  });
});

describe('共有リンクの action', () => {
  it('issueShareLink は token と expiresAt を返す', async () => {
    const fetcher = okFetcher({ ok: true, token: 'dummy-share-token', expiresAt: '2026-12-16T05:47:00.000Z' });
    const data = await issueShareLink('tok', { fetcher, apiUrl: API });
    expect(data.token).toBe('dummy-share-token');
    expect(data.expiresAt).toBe('2026-12-16T05:47:00.000Z');
    expect(lastBody(fetcher)).toEqual({ action: 'issueShareLink', sessionToken: 'tok' });
  });
  it('getShareLinkStatus', async () => {
    const fetcher = okFetcher({ ok: true, active: true, expiresAt: '2026-12-16T05:47:00.000Z' });
    const data = await getShareLinkStatus('tok', { fetcher, apiUrl: API });
    expect(data.active).toBe(true);
    expect(lastBody(fetcher)).toEqual({ action: 'getShareLinkStatus', sessionToken: 'tok' });
  });
  it('getFeedStats はフィード別の集計を返す', async () => {
    const stats = { 'feed-a': { plays: 2, playSeconds: 91, opens: 1, expands: 0, views: 3, lastAt: '2026-11-22T10:00:00.000Z' } };
    const fetcher = okFetcher({ ok: true, stats });
    const data = await getFeedStats('tok', { fetcher, apiUrl: API });
    expect(data.stats).toEqual(stats);
    expect(lastBody(fetcher)).toEqual({ action: 'feed_stats', sessionToken: 'tok' });
  });
  it('revokeShareLink', async () => {
    const fetcher = okFetcher({ ok: true });
    await revokeShareLink('tok', { fetcher, apiUrl: API });
    expect(lastBody(fetcher)).toEqual({ action: 'revokeShareLink', sessionToken: 'tok' });
  });
});

describe('視聴ログの action', () => {
  it('logEvents は log_events にイベント配列をそのまま送る', async () => {
    const events = [
      { ts: '2026-11-17T00:00:00.000Z', type: 'feed_view', feed_id: 'nhk', feed_title: 'NHK', article_id: '', article_title: '' },
      { ts: '2026-11-17T00:01:00.000Z', type: 'play', feed_id: 'nhk', feed_title: 'NHK', article_id: 'a1', article_title: '記事', seconds: 42 },
    ];
    const fetcher = okFetcher({ ok: true, saved: 2 });
    const data = await logEvents('tok', events, { fetcher, apiUrl: API });
    expect(data.saved).toBe(2);
    expect(lastBody(fetcher)).toEqual({ action: 'log_events', sessionToken: 'tok', events });
  });
  it('logEvents はネットワーク失敗でも再試行しない (二重に貯めない)', async () => {
    const fetcher = vi.fn(async () => { throw new TypeError('Load failed'); });
    await expect(logEvents('tok', [], { fetcher, apiUrl: API, retryDelayMs: 0 })).rejects.toThrow('Load failed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
