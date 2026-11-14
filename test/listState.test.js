import { describe, it, expect } from 'vitest';
import {
  createListState,
  visibleArticles,
  patchArticle,
  withUnreadCounts,
  sortArticlesDesc,
  markAllReadInList,
  markAllReadScope,
  visibleFeedChips,
  feedCategories,
} from '../src/lib/listState.js';

const A = (id, feedId, isRead = false) => ({ id, feedId, isRead });
const FEEDS = [
  { id: 'nhk', title: 'NHK', unreadCount: 2 },
  { id: 'zenn', title: 'Zenn', unreadCount: 1 },
];

function baseState() {
  return {
    ...createListState(),
    articles: [A('1', 'nhk'), A('2', 'nhk', true), A('3', 'zenn')],
    feeds: FEEDS.map((f) => ({ ...f })),
  };
}

describe('visibleArticles', () => {
  it('フィードで絞る', () => {
    const s = { ...baseState(), feedId: 'nhk' };
    expect(visibleArticles(s).map((a) => a.id)).toEqual(['1', '2']);
  });
  it('未読フィルタ', () => {
    const s = { ...baseState(), filter: 'unread' };
    expect(visibleArticles(s).map((a) => a.id)).toEqual(['1', '3']);
  });
});

describe('patchArticle', () => {
  it('対象記事だけ差し替え、元配列を壊さない', () => {
    const s = baseState();
    const next = patchArticle(s.articles, '1', { isRead: true });
    expect(next[0].isRead).toBe(true);
    expect(s.articles[0].isRead).toBe(false);
    expect(next[1]).toBe(s.articles[1]);
  });
});

describe('withUnreadCounts', () => {
  it('ローカルの記事からフィード別未読数を付け直す', () => {
    const feeds = [{ id: 'nhk', unreadCount: 99 }, { id: 'zenn' }, { id: 'none' }];
    const articles = [A('1', 'nhk'), A('2', 'nhk', true), A('3', 'zenn'), A('4', 'zenn')];
    const next = withUnreadCounts(feeds, articles);
    expect(next.map((f) => f.unreadCount)).toEqual([1, 2, 0]);
    // 元のフィードは壊さない。
    expect(feeds[0].unreadCount).toBe(99);
  });
});

describe('sortArticlesDesc', () => {
  it('publishedAt の新しい順、無ければ fetchedAt で並べる', () => {
    const articles = [
      { id: 'a', publishedAt: '2026-11-10T00:00:00.000Z', fetchedAt: '2026-11-14T00:00:00.000Z' },
      { id: 'b', publishedAt: '2026-11-12T00:00:00.000Z', fetchedAt: '2026-11-13T00:00:00.000Z' },
      { id: 'c', publishedAt: '', fetchedAt: '2026-11-11T00:00:00.000Z' },
    ];
    expect(sortArticlesDesc(articles).map((x) => x.id)).toEqual(['b', 'c', 'a']);
    expect(articles.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('markAllReadInList / markAllReadScope', () => {
  it('フィード指定ではそのフィードだけ既読化し未読数を 0 にする', () => {
    const next = markAllReadInList(baseState(), 'nhk');
    expect(next.articles.map((a) => a.isRead)).toEqual([true, true, false]);
    expect(next.feeds.find((f) => f.id === 'nhk').unreadCount).toBe(0);
    expect(next.feeds.find((f) => f.id === 'zenn').unreadCount).toBe(1);
  });
  it('フィード省略では全部を既読化する', () => {
    const next = markAllReadInList(baseState(), '');
    expect(next.articles.every((a) => a.isRead)).toBe(true);
    expect(next.feeds.every((f) => f.unreadCount === 0)).toBe(true);
  });
  it('scope はフィード指定がカテゴリより優先される', () => {
    const s = {
      ...createListState(),
      feeds: [
        { id: 'a', category: '楽天' },
        { id: 'b', category: '投資・FIRE' },
      ],
    };
    expect(markAllReadScope(s, 'b', '楽天')).toEqual({ b: true });
    expect(markAllReadScope(s, '', '楽天')).toEqual({ a: true });
    expect(markAllReadScope(s, '', '')).toEqual({ a: true, b: true });
  });
});

describe('visibleFeedChips', () => {
  const feeds = [
    { id: 'a', unreadCount: 3 },
    { id: 'b', unreadCount: 0 },
    { id: 'c', unreadCount: 1 },
  ];
  it('すべてフィルタでは全フィード', () => {
    expect(visibleFeedChips({ feeds, filter: 'all', feedId: '' }).map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });
  it('未読フィルタでは未読があるフィードだけ', () => {
    expect(visibleFeedChips({ feeds, filter: 'unread', feedId: '' }).map((f) => f.id)).toEqual(['a', 'c']);
  });
  it('未読が全くなければ空 (チップは「すべて」だけになる)', () => {
    const zero = feeds.map((f) => ({ ...f, unreadCount: 0 }));
    expect(visibleFeedChips({ feeds: zero, filter: 'unread', feedId: '' })).toEqual([]);
  });
  it('選択中のフィードは未読ゼロでも残す', () => {
    expect(visibleFeedChips({ feeds, filter: 'unread', feedId: 'b' }).map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('feedCategories / カテゴリ絞り込み', () => {
  const feeds = [
    { id: 'a', category: '楽天', unreadCount: 2 },
    { id: 'b', category: '投資・FIRE', unreadCount: 0 },
    { id: 'c', category: '楽天', unreadCount: 0 },
    { id: 'd', category: '', unreadCount: 5 },
  ];
  it('カテゴリ名を出現順・重複なしで返す (空は除く)', () => {
    expect(feedCategories(feeds)).toEqual(['楽天', '投資・FIRE']);
  });
  it('チップはカテゴリで絞られ、未読ルールも重なる', () => {
    expect(visibleFeedChips({ feeds, filter: 'all', feedId: '', category: '楽天' }).map((f) => f.id)).toEqual(['a', 'c']);
    expect(visibleFeedChips({ feeds, filter: 'unread', feedId: '', category: '楽天' }).map((f) => f.id)).toEqual(['a']);
  });
  it('記事もカテゴリで絞る', () => {
    const state = {
      feeds, category: '楽天', feedId: '', filter: 'all',
      articles: [
        { id: '1', feedId: 'a', isRead: false },
        { id: '2', feedId: 'b', isRead: false },
      ],
    };
    expect(visibleArticles(state).map((x) => x.id)).toEqual(['1']);
  });
  it('markAllReadInList はカテゴリ範囲だけ既読化する', () => {
    const state = {
      feeds, category: '楽天', feedId: '', filter: 'unread',
      articles: [
        { id: '1', feedId: 'a', isRead: false },
        { id: '2', feedId: 'b', isRead: false },
      ],
    };
    const next = markAllReadInList(state, '', '楽天');
    expect(next.articles.map((x) => x.isRead)).toEqual([true, false]);
    expect(next.feeds.map((f) => f.unreadCount)).toEqual([0, 0, 0, 5]);
  });
});
