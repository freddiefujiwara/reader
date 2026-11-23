import { describe, it, expect } from 'vitest';
import {
  decodeXmlEntities,
  parseFeedXml,
  parseFeedMeta,
} from '../src/lib/feedParse.js';
import { formatPublishedAt } from '../src/lib/format.js';
import { buildShareUrl, formatShareExpiry } from '../src/lib/shareLink.js';
import { normalizeFeedIds } from '../src/lib/feedHash.js';
import {
  feedDisplayName,
  feedCategories,
  shouldClearCategorySelection,
  visibleArticles,
  patchArticle,
  patchFeedAttrs,
  withUnreadCounts,
  sortArticlesDesc,
  mergePendingReadMarks,
  markAllReadInList,
  markAllReadTargets,
  visibleFeedChips,
} from '../src/lib/listState.js';
import {
  planUpserts,
  planLocalPrune,
  planOrphanArticles,
  mergeTransferredState,
  applyTransferredState,
  articleRecordToView,
} from '../src/lib/localDb.js';
import { formatFeedStatus } from '../src/lib/feedAdmin.js';

// JSON から作れる「文字列化できないオブジェクト」。String() / テンプレート
// リテラル / Date 化のいずれも TypeError になるため、外部データの整形層が
// 素通しすると例外になる。Sheets や API 応答が JSON 経由で来る以上、
// 値の形としては到達しうる。
const BAD = { toString: [] };

const FEED = { id: 'feed1' };
const NOW_ISO = '2026-11-20T00:00:00.000Z';

describe('feedParse: 範囲外の数値文字参照', () => {
  it('&#x110000; (上限超え16進) で投げず、置換文字になる', () => {
    expect(() => decodeXmlEntities('a &#x110000; b')).not.toThrow();
    expect(decodeXmlEntities('a &#x110000; b')).toBe('a � b');
  });
  it('&#1114112; (上限超え10進) で投げず、置換文字になる', () => {
    expect(decodeXmlEntities('&#1114112;')).toBe('�');
  });
  it('巨大な数値参照 (&#99999999999999999999;) でも投げない', () => {
    expect(() => decodeXmlEntities('&#99999999999999999999;')).not.toThrow();
  });
  it('範囲内の参照は従来どおりデコードする', () => {
    expect(decodeXmlEntities('&#x3042;&#12356;')).toBe('あい');
  });
  it('タイトルに範囲外参照を含む item も、フィード全体を落とさず取り出す', () => {
    const xml = `<rss version="2.0"><channel>
      <item><title>壊れた&#x110000;文字</title><link>https://example.com/1</link></item>
      <item><title>正常な記事</title><link>https://example.com/2</link></item>
    </channel></rss>`;
    const entries = parseFeedXml(xml, FEED);
    expect(entries.map((e) => e.link)).toEqual(['https://example.com/1', 'https://example.com/2']);
    expect(entries[0].title).toContain('�');
  });
  it('属性値 (enclosure url) の範囲外参照でも投げない', () => {
    const xml = `<rss version="2.0"><channel><item>
      <title>音声</title><link>https://example.com/a</link>
      <enclosure url="https://example.com/a&#x110000;.mp3" type="audio/mpeg"/>
    </item></channel></rss>`;
    expect(() => parseFeedXml(xml, FEED)).not.toThrow();
  });
  it('チャンネルタイトルに範囲外参照があっても parseFeedMeta が投げない', () => {
    const xml = `<rss version="2.0"><channel><title>局&#xFFFFFF;</title></channel></rss>`;
    expect(parseFeedMeta(xml).title).toContain('�');
  });
});

describe('feedParse: 入力の形が想定外', () => {
  it('null / undefined / 数値 / 空文字は空配列', () => {
    expect(parseFeedXml(null, FEED)).toEqual([]);
    expect(parseFeedXml(undefined, FEED)).toEqual([]);
    expect(parseFeedXml(42, FEED)).toEqual([]);
    expect(parseFeedXml('', FEED)).toEqual([]);
  });
  it('pubDate が解釈できない item は publishedAt が空になる', () => {
    const xml = `<rss version="2.0"><channel><item>
      <title>x</title><link>https://example.com/1</link><pubDate>not a date</pubDate>
    </item></channel></rss>`;
    expect(parseFeedXml(xml, FEED)[0].publishedAt).toBe('');
  });
});

describe('formatPublishedAt: 文字列でない日時', () => {
  const now = new Date(2026, 10, 14, 12, 0, 0);
  it('文字列化できないオブジェクトで投げず、空文字', () => {
    expect(() => formatPublishedAt(BAD, now)).not.toThrow();
    expect(formatPublishedAt(BAD, now)).toBe('');
  });
  it('真偽値・数値 (epoch ミリ秒) は日付として出さない', () => {
    expect(formatPublishedAt(true, now)).toBe('');
    expect(formatPublishedAt(1760000000000, now)).toBe('');
  });
  it('プレーンなオブジェクト・配列は空文字', () => {
    expect(formatPublishedAt({}, now)).toBe('');
    expect(formatPublishedAt([], now)).toBe('');
  });
});

describe('shareLink: 壊れた発行応答・期限', () => {
  it('buildShareUrl: 文字列でない token は空文字 (リンクを作らない)', () => {
    const opts = { origin: 'https://example.com', base: '/reader/' };
    expect(() => buildShareUrl(BAD, opts)).not.toThrow();
    expect(buildShareUrl(BAD, opts)).toBe('');
    expect(buildShareUrl(42, opts)).toBe('');
    expect(buildShareUrl({}, opts)).toBe('');
    expect(buildShareUrl(['tok'], opts)).toBe('');
  });
  it('formatShareExpiry: 文字列でない期限は空文字', () => {
    expect(() => formatShareExpiry(BAD)).not.toThrow();
    expect(formatShareExpiry(BAD)).toBe('');
    expect(formatShareExpiry(1760000000000)).toBe('');
    expect(formatShareExpiry(true)).toBe('');
    expect(formatShareExpiry({})).toBe('');
  });
});

describe('normalizeFeedIds: 壊れたフィード一覧', () => {
  it('配列でない入力は空配列', async () => {
    await expect(normalizeFeedIds(null)).resolves.toEqual([]);
    await expect(normalizeFeedIds(undefined)).resolves.toEqual([]);
    await expect(normalizeFeedIds({ feeds: [] })).resolves.toEqual([]);
    await expect(normalizeFeedIds('https://example.com/feed')).resolves.toEqual([]);
  });
  it('null エントリ・URL の無いエントリは落とし、幽霊フィードを作らない', async () => {
    const out = await normalizeFeedIds([null, undefined, 42, {}, { title: 'no url' }, { url: 42 }]);
    expect(out).toEqual([]);
  });
  it('正常なエントリは ID だけ付け替え、他のフィールドと順序を保つ', async () => {
    const feeds = [
      { id: 'old1', url: 'https://example.com/a.xml', title: 'A' },
      null,
      { id: 'old2', url: 'https://example.com/b.xml', title: 'B' },
    ];
    const out = await normalizeFeedIds(feeds);
    expect(out.map((f) => f.title)).toEqual(['A', 'B']);
    expect(out[0].id).toMatch(/^[0-9a-f]{16}$/);
    expect(out[0].id).not.toBe(out[1].id);
    expect(out[0].url).toBe('https://example.com/a.xml');
  });
});

describe('listState: null エントリ・非配列への耐性', () => {
  it('feedCategories: 非配列は []、null エントリと文字列化できないカテゴリは読み飛ばす', () => {
    expect(feedCategories(null)).toEqual([]);
    expect(feedCategories('abc')).toEqual([]);
    expect(feedCategories([null, { category: ' 音楽 ' }, { category: BAD }, { category: '音楽' }]))
      .toEqual(['音楽']);
  });
  it('visibleArticles: articles が配列でなければ []、feeds の null エントリで落ちない', () => {
    const base = { feeds: [], category: '', feedId: '', filter: 'all' };
    expect(visibleArticles({ ...base, articles: null })).toEqual([]);
    expect(visibleArticles({ ...base, articles: 'abc' })).toEqual([]);
    expect(visibleArticles({ articles: [], feeds: [null], category: 'c', feedId: '', filter: 'all' }))
      .toEqual([]);
  });
  it('patchArticle: 非配列は []、null エントリはそのまま通す', () => {
    expect(patchArticle(null, 'a', { isRead: true })).toEqual([]);
    const out = patchArticle([null, { id: 'a', isRead: false }], 'a', { isRead: true });
    expect(out[0]).toBeNull();
    expect(out[1].isRead).toBe(true);
  });
  it('patchFeedAttrs: null エントリはそのまま通す', () => {
    const out = patchFeedAttrs([null, { id: 'f', category: 'x' }], 'f', { category: 'y' });
    expect(out[0]).toBeNull();
    expect(out[1].category).toBe('y');
  });
  it('withUnreadCounts: null のフィードは落とし、null の記事は数えない', () => {
    const feeds = [{ id: 'f' }, null];
    const articles = [null, { feedId: 'f', isRead: false }, { feedId: 'f', isRead: true }, 'x'];
    const out = withUnreadCounts(feeds, articles);
    expect(out).toEqual([{ id: 'f', unreadCount: 1 }]);
  });
  it('sortArticlesDesc: null エントリ・文字列化できない日時でも投げない', () => {
    const good = { id: 'b', publishedAt: '2026-11-10T00:00:00.000Z', fetchedAt: '' };
    expect(() => sortArticlesDesc([null, good])).not.toThrow();
    const out = sortArticlesDesc([null, good]);
    expect(out[0]).toBe(good);
    expect(out).toHaveLength(2);
    const badDate = { id: 'a', publishedAt: BAD, fetchedAt: '' };
    expect(() => sortArticlesDesc([badDate, good])).not.toThrow();
    expect(sortArticlesDesc([badDate, good])[0]).toBe(good);
  });
  it('mergePendingReadMarks: views の null エントリはそのまま通す', () => {
    const views = [null, { id: 'x', isRead: false }];
    const { articles } = mergePendingReadMarks(views, new Map([['x', true]]));
    expect(articles[0]).toBeNull();
    expect(articles[1].isRead).toBe(true);
  });
  it('markAllRead 系: articles が非配列・null エントリでも投げない', () => {
    const state = { articles: [null, { id: 'a', feedId: 'f', isRead: false }], feeds: [null, { id: 'f' }] };
    expect(() => markAllReadInList(state)).not.toThrow();
    expect(markAllReadInList(state).articles[1].isRead).toBe(true);
    expect(markAllReadTargets(state).map((a) => a.id)).toEqual(['a']);
    expect(markAllReadInList({ articles: null, feeds: null }).articles).toEqual([]);
  });
  it('visibleFeedChips: null エントリでも投げない', () => {
    expect(visibleFeedChips({ feeds: [null], filter: 'unread', feedId: '', category: '' })).toEqual([]);
    expect(visibleFeedChips({ feeds: [null], filter: 'all', feedId: '', category: 'c' })).toEqual([]);
  });
});

describe('listState: フィード表示名とカテゴリ解除判定', () => {
  it('feedDisplayName: 文字列でないタイトル・URL・ID でも投げず、ID へ倒れる', () => {
    expect(() => feedDisplayName({ title: BAD, url: BAD, id: 'fid' })).not.toThrow();
    expect(feedDisplayName({ title: BAD, url: BAD, id: 'fid' })).toBe('fid');
    expect(feedDisplayName(null)).toBe('');
    expect(feedDisplayName({ title: 42, url: '', id: 'fid' })).toBe('fid');
  });
  it('shouldClearCategorySelection: 文字列化できないカテゴリのフィードでも投げない', () => {
    expect(() => shouldClearCategorySelection([{ category: BAD }], 'c')).not.toThrow();
    expect(shouldClearCategorySelection([{ category: BAD }], 'c')).toBe(true);
  });
});

describe('localDb の計画関数: 壊れたレコード・エントリ', () => {
  it('planUpserts: null・文字列エントリは取り込まない (文字列の link プロパティを拾わない)', async () => {
    const entries = [
      null,
      'a string entry',
      { guid: 'g1', link: 'https://example.com/1', title: 't', publishedAt: '', summary: '', author: '', audioUrl: '', durationSec: null },
    ];
    const records = await planUpserts({}, entries, FEED, NOW_ISO);
    expect(records).toHaveLength(1);
    expect(records[0].link).toBe('https://example.com/1');
  });
  it('planUpserts: エントリが配列でなければ空', async () => {
    await expect(planUpserts({}, 'str', FEED, NOW_ISO)).resolves.toEqual([]);
    await expect(planUpserts({}, null, FEED, NOW_ISO)).resolves.toEqual([]);
  });
  it('planLocalPrune: null レコードは無視し、文字列化できない日時は投げずに残す', () => {
    expect(planLocalPrune([null], NOW_ISO)).toEqual([]);
    expect(planLocalPrune('abc', NOW_ISO)).toEqual([]);
    const rec = { id: 'a', is_read: true, fetched_at: BAD, published_at: '' };
    expect(() => planLocalPrune([rec], NOW_ISO)).not.toThrow();
    expect(planLocalPrune([rec], NOW_ISO)).toEqual([]);
  });
  it('planOrphanArticles: null レコードは無視する', () => {
    expect(planOrphanArticles([null, { id: 'a', feed_id: 'gone' }], ['live'])).toEqual(['a']);
    expect(planOrphanArticles(null, [])).toEqual([]);
  });
  it('mergeTransferredState: null の退避エントリは無視する', () => {
    const out = mergeTransferredState({}, [null, { feedId: 'f', link: 'l', state: { is_read: true } }]);
    expect(Object.keys(out)).toEqual(['f\nl']);
  });
  it('applyTransferredState: null レコードはそのまま通す', () => {
    const transfer = { 'f\nl': { is_read: true, read_at: '', play_pos: 0, fetched_at: '' } };
    const { records } = applyTransferredState([null, { id: 'a', link: 'l' }], transfer, 'f', null);
    expect(records[0]).toBeNull();
    expect(records[1].is_read).toBe(true);
  });
  it('articleRecordToView: フィールド欠けのレコードは既定値で表示形になる', () => {
    const view = articleRecordToView({}, 'タイトル', Date.parse(NOW_ISO));
    expect(view.summary).toBe('');
    expect(view.author).toBe('');
    expect(view.audioUrl).toBe('');
    expect(view.isRead).toBe(false);
    expect(view.durationSec).toBeNull();
  });
});

describe('feedAdmin: 壊れた最終取得時刻', () => {
  it('formatFeedStatus: lastFetchedAt が文字列化できない値でも投げない', () => {
    expect(() => formatFeedStatus({ lastFetchedAt: BAD }, new Date())).not.toThrow();
    expect(typeof formatFeedStatus({ lastFetchedAt: BAD }, new Date())).toBe('string');
  });
});
