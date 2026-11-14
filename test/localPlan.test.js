import { describe, it, expect } from 'vitest';
import { planUpserts, planLocalPrune, planOrphanArticles, articleRecordToView } from '../src/lib/localDb.js';
import { articleId } from '../src/lib/articleId.js';

const FEED = { id: 'nhk', title: 'NHK' };
const FETCHED = '2026-11-14T01:00:00.000Z';

const entry = (guid, extra = {}) => ({
  guid,
  title: `title-${guid}`,
  link: `https://example.com/${guid}`,
  publishedAt: '2026-11-13T00:00:00.000Z',
  summary: 'summary',
  author: 'author',
  ...extra,
});

describe('planUpserts', () => {
  it('新規エントリは未読レコードになり、IDはサーバー規則と一致する', async () => {
    const records = await planUpserts({}, [entry('g1')], FEED, FETCHED);
    expect(records.length).toBe(1);
    expect(records[0]).toEqual({
      id: await articleId('nhk', 'g1'),
      feed_id: 'nhk',
      title: 'title-g1',
      link: 'https://example.com/g1',
      published_at: '2026-11-13T00:00:00.000Z',
      fetched_at: FETCHED,
      summary: 'summary',
      author: 'author',
      is_read: false,
      read_at: '',
    });
  });
  it('既存の既読記事は状態と取り込み日時を保ち、メタデータだけ更新する', async () => {
    const id = await articleId('nhk', 'g1');
    const existing = {
      [id]: {
        id, feed_id: 'nhk', title: 'old', link: 'https://example.com/g1',
        published_at: '2026-11-01T00:00:00.000Z', fetched_at: '2026-11-05T00:00:00.000Z',
        summary: 'old summary', author: '', is_read: true, read_at: '2026-11-06T00:00:00.000Z',
      },
    };
    const records = await planUpserts(existing, [entry('g1', { title: 'new title', publishedAt: '' })], FEED, FETCHED);
    expect(records.length).toBe(1);
    expect(records[0].is_read).toBe(true);
    expect(records[0].read_at).toBe('2026-11-06T00:00:00.000Z');
    expect(records[0].fetched_at).toBe('2026-11-05T00:00:00.000Z');
    expect(records[0].title).toBe('new title');
    // 新しい公開日が空なら既存を保つ。
    expect(records[0].published_at).toBe('2026-11-01T00:00:00.000Z');
  });
  it('同じ guid の重複は1件にまとめ、リンク無しは取り込まない', async () => {
    const records = await planUpserts({}, [entry('g1'), entry('g1'), { guid: 'g2', title: 't', link: '', publishedAt: '', summary: '', author: '' }], FEED, FETCHED);
    expect(records.map((r) => r.title)).toEqual(['title-g1']);
  });
  it('guid が空ならリンクでIDを作る', async () => {
    const records = await planUpserts({}, [entry('', { link: 'https://example.com/only-link' })], FEED, FETCHED);
    expect(records[0].id).toBe(await articleId('nhk', 'https://example.com/only-link'));
  });
});

describe('planLocalPrune', () => {
  const NOW = '2026-11-14T00:00:00.000Z';
  const rec = (id, extra = {}) => ({
    id, feed_id: 'nhk', title: id, link: `https://example.com/${id}`,
    published_at: '', fetched_at: '', summary: '', author: '', is_read: true, read_at: '',
    ...extra,
  });
  it('既読で取り込みから60日超は消す (59日は残す)', () => {
    const old = rec('old', { fetched_at: '2026-09-14T00:00:00.000Z' }); // 61日
    const fresh = rec('fresh', { fetched_at: '2026-09-16T00:00:00.000Z' }); // 59日
    expect(planLocalPrune([old, fresh], NOW)).toEqual(['old']);
  });
  it('経過日数は fetched_at 優先、無ければ published_at で数える', () => {
    const byFetched = rec('a', { fetched_at: '2026-11-13T00:00:00.000Z', published_at: '2020-01-01T00:00:00.000Z' });
    const byPublished = rec('b', { fetched_at: '', published_at: '2026-09-01T00:00:00.000Z' });
    expect(planLocalPrune([byFetched, byPublished], NOW)).toEqual(['b']);
  });
  it('未読は古くても消さない', () => {
    const unreadOld = rec('u', { fetched_at: '2020-01-01T00:00:00.000Z', is_read: false });
    expect(planLocalPrune([unreadOld], NOW)).toEqual([]);
  });
  it('上限を超えたら古い既読から消し、未読は件数でも消さない', () => {
    const articles = [
      rec('read-new', { published_at: '2026-11-13T00:00:00.000Z', fetched_at: '2026-11-13T00:00:00.000Z' }),
      rec('read-mid', { published_at: '2026-11-12T00:00:00.000Z', fetched_at: '2026-11-12T00:00:00.000Z' }),
      rec('read-old', { published_at: '2026-11-11T00:00:00.000Z', fetched_at: '2026-11-11T00:00:00.000Z' }),
      rec('unread-oldest', { published_at: '2026-11-01T00:00:00.000Z', fetched_at: '2026-11-01T00:00:00.000Z', is_read: false }),
    ];
    expect(planLocalPrune(articles, NOW, { maxArticles: 2 })).toEqual(['read-old']);
  });
});

describe('planOrphanArticles / articleRecordToView', () => {
  it('フィード一覧に無い記事のIDを返す', () => {
    const articles = [{ id: '1', feed_id: 'nhk' }, { id: '2', feed_id: 'gone' }];
    expect(planOrphanArticles(articles, ['nhk'])).toEqual(['2']);
  });
  it('レコードを表示用へ変換する', () => {
    const view = articleRecordToView({
      id: 'x', feed_id: 'nhk', title: 't', link: 'https://example.com',
      published_at: '2026-11-14T00:00:00.000Z', fetched_at: '2026-11-14T01:00:00.000Z',
      summary: 's', author: 'a', is_read: 1, read_at: '2026-11-14T02:00:00.000Z',
    }, 'NHK');
    expect(view).toEqual({
      id: 'x', feedId: 'nhk', feedTitle: 'NHK', title: 't', link: 'https://example.com',
      publishedAt: '2026-11-14T00:00:00.000Z', fetchedAt: '2026-11-14T01:00:00.000Z',
      summary: 's', author: 'a', isRead: true,
    });
  });
});
