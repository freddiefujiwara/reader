import { describe, it, expect } from 'vitest';
import {
  createListState,
  applyListResponse,
  visibleArticles,
  patchArticle,
  unreadTotal,
  markAllReadInList,
} from '../src/lib/listState.js';

const A = (id, feedId, isRead = false, isStarred = false) => ({ id, feedId, isRead, isStarred });
const FEEDS = [
  { id: 'nhk', title: 'NHK', unreadCount: 2 },
  { id: 'zenn', title: 'Zenn', unreadCount: 1 },
];

function baseState() {
  return {
    ...createListState(),
    articles: [A('1', 'nhk'), A('2', 'nhk', true, true), A('3', 'zenn')],
    feeds: FEEDS.map((f) => ({ ...f })),
    total: 3,
  };
}

describe('applyListResponse', () => {
  it('置き換え取り込みで total と generatedAt を反映する', () => {
    const next = applyListResponse(createListState(), { articles: [A('9', 'nhk')], total: 42, feeds: FEEDS, generatedAt: 'T' });
    expect(next.articles.map((a) => a.id)).toEqual(['9']);
    expect(next.total).toBe(42);
    expect(next.generatedAt).toBe('T');
    expect(next.feeds).toEqual(FEEDS);
  });
  it('append では重複 id を追加しない', () => {
    const s = baseState();
    const next = applyListResponse(s, { articles: [A('3', 'zenn'), A('4', 'zenn')], total: 4 }, { append: true });
    expect(next.articles.map((a) => a.id)).toEqual(['1', '2', '3', '4']);
  });
});

describe('visibleArticles', () => {
  it('フィードで絞る', () => {
    const s = { ...baseState(), feedId: 'nhk' };
    expect(visibleArticles(s).map((a) => a.id)).toEqual(['1', '2']);
  });
  it('未読フィルタ', () => {
    const s = { ...baseState(), filter: 'unread' };
    expect(visibleArticles(s).map((a) => a.id)).toEqual(['1', '3']);
  });
  it('スターフィルタ', () => {
    const s = { ...baseState(), filter: 'starred' };
    expect(visibleArticles(s).map((a) => a.id)).toEqual(['2']);
  });
});

describe('patchArticle / unreadTotal', () => {
  it('対象記事だけ差し替え、元配列を壊さない', () => {
    const s = baseState();
    const next = patchArticle(s.articles, '1', { isRead: true });
    expect(next[0].isRead).toBe(true);
    expect(s.articles[0].isRead).toBe(false);
    expect(next[1]).toBe(s.articles[1]);
  });
  it('未読数を数える', () => {
    expect(unreadTotal(baseState().articles)).toBe(2);
  });
});

describe('markAllReadInList', () => {
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
});
