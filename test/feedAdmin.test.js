import { describe, it, expect } from 'vitest';
import {
  createFeedForm,
  feedFormFromFeed,
  validateFeedForm,
  buildSaveFeedPayload,
  toggleEnabledPayload,
  formatFeedStatus,
  moveFeedOrder,
  createOrderSender,
} from '../src/lib/feedAdmin.js';

describe('createFeedForm / feedFormFromFeed', () => {
  it('空フォームは全フィールド空文字', () => {
    expect(createFeedForm()).toEqual({ id: '', title: '', url: '', category: '' });
  });
  it('フィードから編集フォームを作る (状態系フィールドは含めない)', () => {
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
  it('null フィードでも空フォームになる', () => {
    expect(feedFormFromFeed(null)).toEqual({ id: '', title: '', url: '', category: '' });
  });
});

describe('validateFeedForm', () => {
  const ok = { id: 'nhk-news1', title: 'NHK', url: 'https://example.com/rss', category: 'news' };
  it('正しい入力は空文字 (問題なし)', () => {
    expect(validateFeedForm(ok)).toBe('');
  });
  it('ID がスラッグでないとエラー (大文字・空白・日本語・先頭ハイフン)', () => {
    expect(validateFeedForm({ ...ok, id: 'NHK' })).not.toBe('');
    expect(validateFeedForm({ ...ok, id: 'nhk news' })).not.toBe('');
    expect(validateFeedForm({ ...ok, id: 'ニュース' })).not.toBe('');
    expect(validateFeedForm({ ...ok, id: '-nhk' })).not.toBe('');
    expect(validateFeedForm({ ...ok, id: '' })).not.toBe('');
  });
  it('編集時は ID の検証をしない (変更不可のため)', () => {
    expect(validateFeedForm({ ...ok, id: '何か' }, { isEdit: true })).toBe('');
  });
  it('タイトル空はエラー', () => {
    expect(validateFeedForm({ ...ok, title: '  ' })).not.toBe('');
  });
  it('http URL はエラー、https は通る', () => {
    expect(validateFeedForm({ ...ok, url: 'http://example.com/rss' })).not.toBe('');
    expect(validateFeedForm({ ...ok, url: 'https://example.com/rss' })).toBe('');
  });
  it('URL として解釈できない文字列はエラー', () => {
    expect(validateFeedForm({ ...ok, url: 'example.com/rss' })).not.toBe('');
    expect(validateFeedForm({ ...ok, url: '' })).not.toBe('');
  });
  it('カテゴリ空は許容する', () => {
    expect(validateFeedForm({ ...ok, category: '' })).toBe('');
  });
});

// ID ルールはサーバー側 (reader-gas の FEED_ID_PATTERN
// /^[a-z0-9][a-z0-9-]{0,63}$/) と完全一致させる。境界を固定する。
describe('validateFeedForm ID ルール (サーバーと一致)', () => {
  const base = { title: 'NHK', url: 'https://example.com/rss', category: 'news' };
  it('アンダースコアはエラー', () => {
    expect(validateFeedForm({ ...base, id: 'nhk_news' })).not.toBe('');
  });
  it('64文字ちょうどは通る', () => {
    expect(validateFeedForm({ ...base, id: `a${'b'.repeat(63)}` })).toBe('');
  });
  it('65文字はエラー', () => {
    expect(validateFeedForm({ ...base, id: `a${'b'.repeat(64)}` })).not.toBe('');
  });
  it('先頭ハイフンはエラー', () => {
    expect(validateFeedForm({ ...base, id: '-nhk' })).not.toBe('');
  });
  it('大文字はエラー', () => {
    expect(validateFeedForm({ ...base, id: 'NHK' })).not.toBe('');
  });
});

describe('buildSaveFeedPayload', () => {
  it('新規は enabled=true / isPrivate=false で、前後の空白を落とす', () => {
    const payload = buildSaveFeedPayload({
      id: ' nhk ',
      title: ' NHK ',
      url: ' https://example.com/rss ',
      category: ' news ',
    });
    expect(payload).toEqual({
      id: 'nhk',
      title: 'NHK',
      url: 'https://example.com/rss',
      category: 'news',
      enabled: true,
      isPrivate: false,
    });
  });
  it('編集時は元の enabled / isPrivate を引き継ぐ', () => {
    const base = { id: 'mf', enabled: false, isPrivate: true };
    const payload = buildSaveFeedPayload(
      { id: 'mf', title: '家計', url: 'https://a.ze.gs/mfcf.xml', category: 'private' },
      base
    );
    expect(payload.enabled).toBe(false);
    expect(payload.isPrivate).toBe(true);
  });
});

describe('toggleEnabledPayload', () => {
  it('有効→無効、他のフィールドはそのまま', () => {
    const feed = {
      id: 'nhk',
      title: 'NHK',
      url: 'https://example.com/rss',
      category: 'news',
      enabled: true,
      isPrivate: false,
    };
    expect(toggleEnabledPayload(feed)).toEqual({ ...feed, enabled: false });
  });
  it('無効→有効', () => {
    const feed = { id: 'x', title: 'X', url: 'https://example.com/f', category: '', enabled: false, isPrivate: true };
    expect(toggleEnabledPayload(feed)).toEqual({ ...feed, enabled: true });
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
