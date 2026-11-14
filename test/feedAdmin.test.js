import { describe, it, expect } from 'vitest';
import {
  createFeedForm,
  feedFormFromFeed,
  validateFeedUrl,
  isYouTubeFeedUrl,
  planFeedAdd,
  resolveFeedAddForm,
  buildSaveFeedPayload,
  filterAdminFeeds,
  formatFeedStatus,
  moveFeedOrder,
  createOrderSender,
} from '../src/lib/feedAdmin.js';

describe('createFeedForm / feedFormFromFeed', () => {
  it('追加フォームは URL とジャンルだけ', () => {
    expect(createFeedForm()).toEqual({ url: '', category: '' });
  });
  it('編集フォームは表示用の ID / タイトル / URL と、編集用のジャンルだけを持つ', () => {
    const feed = {
      id: 'nhk',
      title: 'NHK',
      url: 'https://example.com/rss',
      category: 'news',
      enabled: false,
      isPrivate: true,
      unreadCount: 5,
    };
    expect(feedFormFromFeed(feed)).toEqual({
      id: 'nhk',
      title: 'NHK',
      url: 'https://example.com/rss',
      category: 'news',
    });
  });
  it('フィードに enabled があってもフォームには持ち込まない', () => {
    const form = feedFormFromFeed({ id: 'x', title: 'X', url: 'https://example.com/f', category: '', enabled: false });
    expect('enabled' in form).toBe(false);
  });
  it('null フィードでも空フォームになる', () => {
    expect(feedFormFromFeed(null)).toEqual({ id: '', title: '', url: '', category: '' });
  });
});

describe('validateFeedUrl', () => {
  it('https は問題なし', () => {
    expect(validateFeedUrl('https://example.com/rss')).toBe('');
    expect(validateFeedUrl(' https://example.com/rss ')).toBe('');
  });
  it('http・形式不正・空はエラー', () => {
    expect(validateFeedUrl('http://example.com/rss')).not.toBe('');
    expect(validateFeedUrl('example.com/rss')).not.toBe('');
    expect(validateFeedUrl('')).not.toBe('');
  });
});

describe('isYouTubeFeedUrl (YouTube 疑似フィードの判定)', () => {
  it('channel_id つきの videos.xml は該当する', () => {
    expect(isYouTubeFeedUrl('https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxx')).toBe(true);
    expect(isYouTubeFeedUrl('https://youtube.com/feeds/videos.xml?channel_id=UCxxxx')).toBe(true);
    expect(isYouTubeFeedUrl('https://m.youtube.com/feeds/videos.xml?channel_id=UCxxxx')).toBe(true);
  });
  it('channel_id が無ければ該当しない', () => {
    expect(isYouTubeFeedUrl('https://www.youtube.com/feeds/videos.xml')).toBe(false);
    expect(isYouTubeFeedUrl('https://www.youtube.com/feeds/videos.xml?channel_id=')).toBe(false);
  });
  it('通常フィードやチャンネルページは該当しない', () => {
    expect(isYouTubeFeedUrl('https://feeds.rebuild.fm/rebuildfm')).toBe(false);
    expect(isYouTubeFeedUrl('https://www.youtube.com/@example')).toBe(false);
    expect(isYouTubeFeedUrl('not-a-url')).toBe(false);
    expect(isYouTubeFeedUrl('')).toBe(false);
  });
});

describe('planFeedAdd (追加の進め方)', () => {
  it('YouTube 疑似フィードは取得を省く', () => {
    expect(planFeedAdd({ url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCx' }))
      .toEqual({ mode: 'youtube' });
  });
  it('それ以外は保存前に取得する', () => {
    expect(planFeedAdd({ url: 'https://feeds.rebuild.fm/rebuildfm' })).toEqual({ mode: 'fetch' });
    expect(planFeedAdd({ url: '' })).toEqual({ mode: 'fetch' });
  });
});

describe('resolveFeedAddForm (取得結果でタイトルを決める)', () => {
  const RSS = `<rss version="2.0"><channel><title>Rebuild</title>
    <item><title>ep1</title><link>https://feeds.rebuild.fm/ep1</link></item>
  </channel></rss>`;
  const NO_TITLE = `<rss version="2.0"><channel>
    <item><title>ep1</title><link>https://example.com/ep1</link></item>
  </channel></rss>`;
  const url = 'https://feeds.rebuild.fm/rebuildfm';

  it('タイトルはフィードから取り、ID は含めない (空白は落とす)', () => {
    const resolved = resolveFeedAddForm({ url: ` ${url} `, category: ' tech ' }, { xml: RSS });
    expect(resolved).toEqual({
      ok: true,
      form: { url, category: 'tech', title: 'Rebuild' },
    });
    expect('id' in resolved.form).toBe(false);
  });
  it('タイトルがフィードから取れなければ ok:false で保存させない', () => {
    const resolved = resolveFeedAddForm({ url, category: '' }, { xml: NO_TITLE });
    expect(resolved.ok).toBe(false);
    expect(resolved.message).toContain('タイトル');
  });
});

describe('buildSaveFeedPayload', () => {
  it('新規は ID を送らず、isPrivate=false (空白は落とす)', () => {
    const payload = buildSaveFeedPayload({
      title: ' Rebuild ',
      url: ' https://feeds.rebuild.fm/rebuildfm ',
      category: ' tech ',
    });
    expect(payload).toEqual({
      title: 'Rebuild',
      url: 'https://feeds.rebuild.fm/rebuildfm',
      category: 'tech',
      isPrivate: false,
    });
    expect('id' in payload).toBe(false);
  });
  it('新規 (YouTube) はタイトル空でもそのまま送る', () => {
    const payload = buildSaveFeedPayload({
      title: '',
      url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCx',
      category: '',
    });
    expect(payload.title).toBe('');
    expect('id' in payload).toBe(false);
  });
  it('編集時は ID / タイトル / URL / isPrivate は元を引き継ぎ、ジャンルだけをフォームから取る', () => {
    const base = {
      id: 'b81e59da11f890d2',
      title: 'Rebuild',
      url: 'https://feeds.rebuild.fm/rebuildfm',
      category: 'old',
      enabled: true,
      isPrivate: true,
    };
    const payload = buildSaveFeedPayload(
      { id: '書き換えたふり', title: '書き換えたふり', url: 'https://evil.example/', category: ' new ', enabled: false },
      base
    );
    expect(payload).toEqual({
      id: 'b81e59da11f890d2',
      title: 'Rebuild',
      url: 'https://feeds.rebuild.fm/rebuildfm',
      category: 'new',
      isPrivate: true,
    });
  });
  it('編集でフォームに enabled があってもペイロードには含めない', () => {
    const base = { id: 'x', title: 'X', url: 'https://example.com/f', category: 'old', isPrivate: false };
    const payload = buildSaveFeedPayload({ category: 'news', enabled: false }, base);
    expect('enabled' in payload).toBe(false);
    expect(payload.category).toBe('news');
  });
});

describe('filterAdminFeeds (管理画面のジャンル絞り込み)', () => {
  const feeds = [
    { id: 'a', category: 'ポッドキャスト' },
    { id: 'b', category: 'ニュース' },
    { id: 'c', category: 'ポッドキャスト' },
    { id: 'd', category: '' },
    { id: 'e' },
  ];
  it('カテゴリ未指定 (空) は全件を順序そのまま返す', () => {
    expect(filterAdminFeeds(feeds, '').map((f) => f.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(filterAdminFeeds(feeds).map((f) => f.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(filterAdminFeeds(feeds, null).map((f) => f.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('一致するカテゴリのフィードだけを残す', () => {
    expect(filterAdminFeeds(feeds, 'ポッドキャスト').map((f) => f.id)).toEqual(['a', 'c']);
    expect(filterAdminFeeds(feeds, 'ニュース').map((f) => f.id)).toEqual(['b']);
  });
  it('一致するフィードが無ければ空配列', () => {
    expect(filterAdminFeeds(feeds, '存在しない')).toEqual([]);
  });
  it('前後の空白は除いて比べる (指定側・フィード側の両方)', () => {
    expect(filterAdminFeeds(feeds, ' ポッドキャスト ').map((f) => f.id)).toEqual(['a', 'c']);
    const spaced = [{ id: 'x', category: ' ニュース ' }];
    expect(filterAdminFeeds(spaced, 'ニュース').map((f) => f.id)).toEqual(['x']);
  });
  it('入力が配列でなくても落ちず、元配列は変えない', () => {
    expect(filterAdminFeeds(null, 'ニュース')).toEqual([]);
    expect(filterAdminFeeds(undefined, '')).toEqual([]);
    filterAdminFeeds(feeds, 'ニュース');
    expect(feeds.map((f) => f.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('moveFeedOrder', () => {
  const feeds = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  it('上へ動かす', () => {
    expect(moveFeedOrder(feeds, 'b', -1).map((f) => f.id)).toEqual(['b', 'a', 'c']);
  });
  it('下へ動かす', () => {
    expect(moveFeedOrder(feeds, 'b', 1).map((f) => f.id)).toEqual(['a', 'c', 'b']);
  });
  it('端では null', () => {
    expect(moveFeedOrder(feeds, 'a', -1)).toBeNull();
    expect(moveFeedOrder(feeds, 'c', 1)).toBeNull();
  });
  it('未知の id は null で、元配列は変えない', () => {
    expect(moveFeedOrder(feeds, 'nope', 1)).toBeNull();
    expect(feeds.map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('formatFeedStatus', () => {
  const now = new Date(2026, 10, 14, 12, 0, 0);
  it('未取得は「未取得」だけ', () => {
    expect(formatFeedStatus({}, now)).toBe('未取得');
  });
  it('取得済みは時刻とステータスを並べる', () => {
    const feed = { lastFetchedAt: '2026-11-14T03:00:00.000Z', lastStatus: 200 };
    const text = formatFeedStatus(feed, now);
    expect(text).toContain('最終取得');
    expect(text).toContain('状態 200');
  });
  it('エラーがある場合はステータスよりエラーを優先する', () => {
    const feed = { lastFetchedAt: '2026-11-14T03:00:00.000Z', lastStatus: 200, lastError: 'HTTP 404' };
    const text = formatFeedStatus(feed, now);
    expect(text).toContain('エラー: HTTP 404');
    expect(text).not.toContain('状態 200');
  });
});

describe('createOrderSender', () => {
  it('1回 submit すると1回送って解決する', async () => {
    const sent = [];
    const sender = createOrderSender(async (ids) => { sent.push(ids); });
    await sender.submit(['a', 'b']);
    expect(sent).toEqual([['a', 'b']]);
  });

  it('送信中の submit は最新順序に合体され、送信は2回で済む', async () => {
    const sent = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const sender = createOrderSender(async (ids) => { sent.push(ids); await gate; });
    const p1 = sender.submit(['a', 'b', 'c']);
    const p2 = sender.submit(['b', 'a', 'c']);
    const p3 = sender.submit(['b', 'c', 'a']);
    release();
    await Promise.all([p1, p2, p3]);
    expect(sent).toEqual([['a', 'b', 'c'], ['b', 'c', 'a']]);
  });

  it('失敗した送信の submit は reject し、次の submit は送れる', async () => {
    let calls = 0;
    const sender = createOrderSender(async () => {
      calls += 1;
      if (calls === 1) throw new Error('forbidden');
    });
    await expect(sender.submit(['a'])).rejects.toThrow('forbidden');
    await sender.submit(['b']);
    expect(calls).toBe(2);
  });
});
