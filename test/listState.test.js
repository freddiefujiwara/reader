import { describe, it, expect } from 'vitest';
import {
  createListState,
  visibleArticles,
  patchArticle,
  patchFeedCategory,
  shouldClearCategorySelection,
  withUnreadCounts,
  sortArticlesDesc,
  markAllReadInList,
  markAllReadScope,
  markAllReadTargets,
  mergePendingReadMarks,
  mergePendingStarMarks,
  isPlayableArticle,
  visibleFeedChips,
  feedCategories,
  feedDisplayName,
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

describe('markAllReadTargets', () => {
  it('全体では未読だけを返し、既読は含めない', () => {
    expect(markAllReadTargets(baseState(), '', '').map((a) => a.id)).toEqual(['1', '3']);
  });
  it('フィード指定ではそのフィードの未読だけを返す', () => {
    expect(markAllReadTargets(baseState(), 'nhk', '').map((a) => a.id)).toEqual(['1']);
    expect(markAllReadTargets(baseState(), 'zenn', '').map((a) => a.id)).toEqual(['3']);
  });
  it('カテゴリ指定ではカテゴリ内フィードの未読だけを返す', () => {
    const s = {
      ...createListState(),
      feeds: [
        { id: 'a', category: '楽天', unreadCount: 1 },
        { id: 'b', category: '投資・FIRE', unreadCount: 1 },
        { id: 'c', category: '楽天', unreadCount: 0 },
      ],
      articles: [A('1', 'a'), A('2', 'b'), A('3', 'c', true)],
    };
    expect(markAllReadTargets(s, '', '楽天').map((a) => a.id)).toEqual(['1']);
  });
  it('フィード指定がカテゴリより優先される', () => {
    const s = {
      ...createListState(),
      feeds: [
        { id: 'a', category: '楽天', unreadCount: 1 },
        { id: 'b', category: '投資・FIRE', unreadCount: 1 },
      ],
      articles: [A('1', 'a'), A('2', 'b')],
    };
    expect(markAllReadTargets(s, 'b', '楽天').map((a) => a.id)).toEqual(['2']);
  });
  it('すべて既読なら空を返す', () => {
    const s = baseState();
    s.articles = s.articles.map((a) => ({ ...a, isRead: true }));
    expect(markAllReadTargets(s, '', '')).toEqual([]);
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
  it('未読が全くなければ空', () => {
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
  it('フィード×未読の重なりで絞る', () => {
    const state = {
      feeds, category: '', feedId: 'a', filter: 'unread',
      articles: [
        { id: '1', feedId: 'a', isRead: false },
        { id: '2', feedId: 'a', isRead: true },
        { id: '3', feedId: 'b', isRead: false },
      ],
    };
    expect(visibleArticles(state).map((x) => x.id)).toEqual(['1']);
  });
  it('カテゴリ×フィードの重なり (選択フィードがカテゴリ外なら出ない)', () => {
    const mk = (category, feedId) => ({
      feeds, category, feedId, filter: 'all',
      articles: [
        { id: '1', feedId: 'a', isRead: false },
        { id: '2', feedId: 'b', isRead: false },
      ],
    });
    // b は「投資・FIRE」なので、カテゴリ「楽天」とフィード b の両立はしない。
    expect(visibleArticles(mk('楽天', 'b'))).toEqual([]);
    expect(visibleArticles(mk('投資・FIRE', 'b')).map((x) => x.id)).toEqual(['2']);
  });
  it('カテゴリ×未読の重なりで絞る', () => {
    const state = {
      feeds, category: '楽天', feedId: '', filter: 'unread',
      articles: [
        { id: '1', feedId: 'a', isRead: false },
        { id: '2', feedId: 'c', isRead: true },
        { id: '3', feedId: 'b', isRead: false },
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

describe('feedDisplayName', () => {
  it('タイトルがあればそれを出す (前後の空白は落とす)', () => {
    expect(feedDisplayName({ id: 'x', title: ' NHK ', url: 'https://example.com/rss' })).toBe('NHK');
  });
  it('タイトル未取得なら URL のホスト名で代替する', () => {
    expect(feedDisplayName({ id: 'x', title: '', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCx' }))
      .toBe('www.youtube.com');
    expect(feedDisplayName({ id: 'x', title: '  ', url: 'https://anchor.fm/s/8c2088c/podcast/rss' }))
      .toBe('anchor.fm');
  });
  it('URL も解釈できなければ ID を出す', () => {
    expect(feedDisplayName({ id: 'abc123', title: '', url: 'not-a-url' })).toBe('abc123');
    expect(feedDisplayName(null)).toBe('');
  });
});

describe('shouldClearCategorySelection', () => {
  const feeds = [
    { id: 'a', category: 'ニュース' },
    { id: 'b', category: '技術' },
    { id: 'c', category: '' },
  ];
  it('選択中カテゴリを持つフィードがあれば維持する', () => {
    expect(shouldClearCategorySelection(feeds, 'ニュース')).toBe(false);
    expect(shouldClearCategorySelection(feeds, '技術')).toBe(false);
  });
  it('選択中カテゴリを持つフィードが1つも無ければ解除する', () => {
    expect(shouldClearCategorySelection(feeds, '川口')).toBe(true);
  });
  it('一覧が空 (読み込み中・未取得) の間は解除しない', () => {
    expect(shouldClearCategorySelection([], 'ニュース')).toBe(false);
    expect(shouldClearCategorySelection(null, 'ニュース')).toBe(false);
    expect(shouldClearCategorySelection(undefined, 'ニュース')).toBe(false);
  });
  it('選択が無い (空) ときは解除しない', () => {
    expect(shouldClearCategorySelection(feeds, '')).toBe(false);
    expect(shouldClearCategorySelection(feeds, null)).toBe(false);
  });
  it('カテゴリは前後の空白を除いて比べる', () => {
    expect(shouldClearCategorySelection([{ id: 'a', category: ' ニュース ' }], 'ニュース')).toBe(false);
    expect(shouldClearCategorySelection(feeds, ' ニュース ')).toBe(false);
  });
});

describe('patchFeedCategory', () => {
  const FEEDS_WITH_CAT = [
    { id: 'a', title: 'A', category: 'ニュース' },
    { id: 'b', title: 'B', category: '技術' },
  ];

  it('対象フィードのカテゴリだけを差し替え、元の配列は壊さない', () => {
    const out = patchFeedCategory(FEEDS_WITH_CAT, 'a', '川口');
    expect(out.map((f) => [f.id, f.category])).toEqual([
      ['a', '川口'],
      ['b', '技術'],
    ]);
    expect(FEEDS_WITH_CAT[0].category).toBe('ニュース');
    expect(out[1]).toBe(FEEDS_WITH_CAT[1]);
  });

  it('対象が無ければ中身は同じ (カテゴリは付けない)', () => {
    const out = patchFeedCategory(FEEDS_WITH_CAT, 'missing', '川口');
    expect(out.map((f) => [f.id, f.category])).toEqual([
      ['a', 'ニュース'],
      ['b', '技術'],
    ]);
  });

  it('空カテゴリへの変更 (ジャンル解除) もそのまま反映する', () => {
    const out = patchFeedCategory(FEEDS_WITH_CAT, 'b', '');
    expect(out[1].category).toBe('');
    expect(feedCategories(out)).toEqual(['ニュース']);
  });
});

describe('mergePendingReadMarks', () => {
  const views = () => [
    { id: 'a', isRead: false },
    { id: 'b', isRead: true },
    { id: 'c', isRead: false },
  ];

  it('控えが無ければ一覧はそのままで、keep は空', () => {
    const v = views();
    const out = mergePendingReadMarks(v, new Map());
    expect(out.articles).toBe(v);
    expect(out.keep.size).toBe(0);
  });

  it('スナップショットが古い (未読のまま) 記事は、控えの既読で上書きし、keep に残す', () => {
    const out = mergePendingReadMarks(views(), new Map([['a', true]]));
    expect(out.articles.map((x) => [x.id, x.isRead])).toEqual([
      ['a', true],
      ['b', true],
      ['c', false],
    ]);
    expect([...out.keep.entries()]).toEqual([['a', true]]);
  });

  it('スナップショット側が既に控えと一致していれば、控えから落とす (keep に残さない)', () => {
    const out = mergePendingReadMarks(views(), new Map([['b', true]]));
    expect(out.articles.map((x) => x.isRead)).toEqual([false, true, false]);
    expect(out.keep.size).toBe(0);
  });

  it('未読へ戻す変更も対称に扱う', () => {
    const out = mergePendingReadMarks(views(), new Map([['b', false]]));
    expect(out.articles.map((x) => [x.id, x.isRead])).toEqual([
      ['a', false],
      ['b', false],
      ['c', false],
    ]);
    expect([...out.keep.entries()]).toEqual([['b', false]]);
  });

  it('一覧から消えた記事への控えは落とす', () => {
    const out = mergePendingReadMarks(views(), new Map([['gone', true]]));
    expect(out.keep.size).toBe(0);
    expect(out.articles.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('元の記事オブジェクトは壊さない', () => {
    const v = views();
    mergePendingReadMarks(v, new Map([['a', true]]));
    expect(v[0].isRead).toBe(false);
  });
});

describe('patchArticle のスター差し替え', () => {
  it('starred / starState だけを差し替え、他は壊さない', () => {
    const before = [{ id: 'a', isRead: false, starred: false, starState: '' }];
    const out = patchArticle(before, 'a', { starred: true, starState: 'on' });
    expect(out[0]).toEqual({ id: 'a', isRead: false, starred: true, starState: 'on' });
    expect(before[0].starred).toBe(false);
  });
});

describe('isPlayableArticle', () => {
  const yt = new Set(['yt-feed']);
  const withAudio = { audioUrl: 'https://example.com/a.m4a' };

  it('音声URLが無ければ、どのフィードでも対象外', () => {
    expect(isPlayableArticle({ feedId: 'pod', audioUrl: '' }, yt)).toBe(false);
    expect(isPlayableArticle({ feedId: 'yt-feed', audioUrl: '', starred: true }, yt)).toBe(false);
  });

  it('YouTube 以外のフィードは、音声URLがあればスター無しでも対象', () => {
    expect(isPlayableArticle({ ...withAudio, feedId: 'pod', starred: false }, yt)).toBe(true);
  });

  it('YouTube フィードは、スター付きのときだけ対象', () => {
    expect(isPlayableArticle({ ...withAudio, feedId: 'yt-feed', starred: true }, yt)).toBe(true);
    expect(isPlayableArticle({ ...withAudio, feedId: 'yt-feed', starred: false }, yt)).toBe(false);
    expect(isPlayableArticle({ ...withAudio, feedId: 'yt-feed' }, yt)).toBe(false);
  });
});

describe('mergePendingStarMarks', () => {
  const views = () => [
    { id: 'a', starred: false, starState: '' },
    { id: 'b', starred: true, starState: 'on' },
    { id: 'c', starred: true, starState: '' },
  ];

  it('控えが無ければ一覧はそのままで、keep は空', () => {
    const v = views();
    const out = mergePendingStarMarks(v, new Map());
    expect(out.articles).toBe(v);
    expect(out.keep.size).toBe(0);
  });

  it('スナップショットが古い記事は、控えのスターで上書きし、keep に残す', () => {
    const out = mergePendingStarMarks(views(), new Map([['a', { starred: true, starState: 'on' }]]));
    expect(out.articles[0]).toEqual({ id: 'a', starred: true, starState: 'on' });
    expect([...out.keep.keys()]).toEqual(['a']);
  });

  it('スナップショット側が既に控えと一致していれば、控えから落とす', () => {
    const out = mergePendingStarMarks(views(), new Map([['b', { starred: true, starState: 'on' }]]));
    expect(out.keep.size).toBe(0);
    expect(out.articles[1].starred).toBe(true);
  });

  it('外す変更も対称に扱う (starState の違いだけでも不一致とみなす)', () => {
    const out = mergePendingStarMarks(views(), new Map([['c', { starred: false, starState: 'off' }]]));
    expect(out.articles[2]).toEqual({ id: 'c', starred: false, starState: 'off' });
    expect([...out.keep.keys()]).toEqual(['c']);
  });

  it('一覧から消えた記事への控えは落とす', () => {
    const out = mergePendingStarMarks(views(), new Map([['gone', { starred: true, starState: 'on' }]]));
    expect(out.keep.size).toBe(0);
  });
});
