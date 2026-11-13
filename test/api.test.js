import { describe, it, expect, vi } from 'vitest';
import { postJson, exchangeSession, exchangeShare, listArticles, markArticle, markAllRead } from '../src/lib/api.js';

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
  it('HTTP エラーはステータス付きで投げる', async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(postJson({ action: 'list' }, { fetcher, apiUrl: API })).rejects.toThrow('HTTP 500');
  });
  it('API URL 未設定なら api_not_configured', async () => {
    await expect(postJson({ action: 'list' }, { fetcher: okFetcher({}), apiUrl: '' })).rejects.toThrow('api_not_configured');
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
  it('markArticle は指定したパッチだけ送る', async () => {
    const fetcher = okFetcher({ ok: true });
    await markArticle('tok', 'a1', { isStarred: true }, { fetcher, apiUrl: API });
    expect(lastBody(fetcher)).toEqual({ action: 'mark', sessionToken: 'tok', articleId: 'a1', isStarred: true });
  });
  it('markAllRead は feedId 省略で送らない', async () => {
    const fetcher = okFetcher({ ok: true, marked: 3 });
    await markAllRead('tok', '', { fetcher, apiUrl: API });
    expect(lastBody(fetcher)).toEqual({ action: 'markAllRead', sessionToken: 'tok' });
  });
});
