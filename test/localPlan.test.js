import { describe, it, expect } from 'vitest';
import {
  planUpserts,
  planLocalPrune,
  planSyncDeletions,
  planOrphanArticles,
  articleRecordToView,
  planFeedRekey,
  planYouTubeChannelPairs,
  planYouTubeArticleRekey,
  transferKey,
  mergeTransferredState,
  applyTransferredState,
  pruneTransferredState,
} from '../src/lib/localDb.js';
import { articleId } from '../src/lib/articleId.js';
import { feedIdFromUrl } from '../src/lib/feedHash.js';

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
      content: '',
      author: 'author',
      audio_url: '',
      audio_url_at: '',
      audio_stale: false,
      duration_sec: null,
      play_pos: 0,
      is_read: false,
      read_at: '',
      starred: false,
      star_state: '',
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
  it('全文 (content) は新規・既存どちらのレコードにも入り、既存の状態は保たれる', async () => {
    const withContent = entry('g1', { content: '全文のテキスト' });
    const [created] = await planUpserts({}, [withContent], FEED, FETCHED);
    expect(created.content).toBe('全文のテキスト');

    const id = await articleId('nhk', 'g1');
    const existing = {
      [id]: {
        id, feed_id: 'nhk', title: 'old', link: 'https://example.com/g1',
        published_at: '2026-11-01T00:00:00.000Z', fetched_at: '2026-11-05T00:00:00.000Z',
        summary: 'old summary', author: '', is_read: true, read_at: '2026-11-06T00:00:00.000Z',
        play_pos: 30,
      },
    };
    const [updated] = await planUpserts(existing, [withContent], FEED, FETCHED);
    expect(updated.content).toBe('全文のテキスト');
    expect(updated.is_read).toBe(true);
    expect(updated.play_pos).toBe(30);
  });
  it('全文の無いエントリでは content は空文字になる', async () => {
    const [record] = await planUpserts({}, [entry('g1')], FEED, FETCHED);
    expect(record.content).toBe('');
  });
  it('同じ guid の重複は1件にまとめ、リンク無しは取り込まない', async () => {
    const records = await planUpserts({}, [entry('g1'), entry('g1'), { guid: 'g2', title: 't', link: '', publishedAt: '', summary: '', author: '' }], FEED, FETCHED);
    expect(records.map((r) => r.title)).toEqual(['title-g1']);
  });
  it('音声つきエントリは audio_url / duration_sec を持ち、更新で最新化され再生位置は保たれる', async () => {
    const pod = entry('p1', { audioUrl: 'https://example.com/p1.mp3', durationSec: 3723 });
    const [created] = await planUpserts({}, [pod], FEED, FETCHED);
    expect(created.audio_url).toBe('https://example.com/p1.mp3');
    expect(created.duration_sec).toBe(3723);
    expect(created.play_pos).toBe(0);
    const existing = { [created.id]: { ...created, play_pos: 120 } };
    const moved = entry('p1', { audioUrl: 'https://cdn.example.com/p1.mp3', durationSec: 3700 });
    const [updated] = await planUpserts(existing, [moved], FEED, FETCHED);
    expect(updated.audio_url).toBe('https://cdn.example.com/p1.mp3');
    expect(updated.duration_sec).toBe(3700);
    expect(updated.play_pos).toBe(120);
  });
  it('不変条件: 新鮮な既存レコードに対しては既読を未読へ戻さず、再生位置も減らさない', async () => {
    const id = await articleId('nhk', 'g1');
    const existing = {
      [id]: {
        id, feed_id: 'nhk', title: 'old', link: 'https://example.com/g1',
        published_at: '2026-11-01T00:00:00.000Z', fetched_at: '2026-11-05T00:00:00.000Z',
        summary: '', author: '', audio_url: 'https://example.com/g1.mp3', duration_sec: 100,
        play_pos: 55, is_read: true, read_at: '2026-11-06T00:00:00.000Z',
      },
    };
    const [record] = await planUpserts(existing, [entry('g1')], FEED, FETCHED);
    expect(record.is_read).toBe(true);
    expect(record.read_at).toBe('2026-11-06T00:00:00.000Z');
    expect(record.play_pos).toBe(55);
  });
  it('guid が空ならリンクでIDを作る', async () => {
    const records = await planUpserts({}, [entry('', { link: 'https://example.com/only-link' })], FEED, FETCHED);
    expect(records[0].id).toBe(await articleId('nhk', 'https://example.com/only-link'));
  });
  it('過去分 (公開が保持期間の60日より古い) の新規エントリはレコードを作らない', async () => {
    // FETCHED = 2026-11-14。61日前 = 2026-09-14 は過去分、59日前は対象内。
    const old = entry('old1', { publishedAt: '2026-09-14T01:00:00.000Z' });
    const recent = entry('new1', { publishedAt: '2026-09-16T01:00:00.000Z' });
    const records = await planUpserts({}, [old, recent], FEED, FETCHED);
    expect(records.map((r) => r.title)).toEqual(['title-new1']);
  });
  it('ちょうど60日ちょうどのエントリは作る (掃除側の「60日を過ぎたら」と対称)', async () => {
    const boundary = entry('b1', { publishedAt: '2026-09-15T01:00:00.000Z' });
    const records = await planUpserts({}, [boundary], FEED, FETCHED);
    expect(records.length).toBe(1);
  });
  it('公開日時が空・エントリに無い場合は過去分とみなさず作る', async () => {
    const noDate = entry('n1', { publishedAt: '' });
    const badDate = entry('n2', { publishedAt: 'not-a-date' });
    const records = await planUpserts({}, [noDate, badDate], FEED, FETCHED);
    expect(records.length).toBe(2);
  });
  it('過去分でも既存レコードは更新され、既読状態を保つ', async () => {
    const id = await articleId('nhk', 'old1');
    const existing = {
      [id]: {
        id, feed_id: 'nhk', title: 'old', link: 'https://example.com/old1',
        published_at: '2020-01-01T00:00:00.000Z', fetched_at: '2026-11-05T00:00:00.000Z',
        summary: 'old summary', author: '', is_read: true, read_at: '2026-11-06T00:00:00.000Z',
      },
    };
    const records = await planUpserts(existing, [entry('old1', { publishedAt: '2020-01-01T00:00:00.000Z', title: 'new title' })], FEED, FETCHED);
    expect(records.length).toBe(1);
    expect(records[0].is_read).toBe(true);
    expect(records[0].title).toBe('new title');
  });
  it('YouTube チャンネル／プレイリストのフィードでは過去分も作る', async () => {
    const old = entry('v1', { publishedAt: '2020-01-01T00:00:00.000Z' });
    const channelFeed = { id: 'yt1', title: 'ch', url: 'https://www.youtube.com/channel/UC0123456789ab' };
    const playlistFeed = { id: 'yt2', title: 'pl', url: 'https://www.youtube.com/playlist?list=PL0123456789ab' };
    await expect(planUpserts({}, [old], channelFeed, FETCHED)).resolves.toHaveLength(1);
    await expect(planUpserts({}, [old], playlistFeed, FETCHED)).resolves.toHaveLength(1);
  });
});

describe('planUpserts の音声URL保持 (stale)', () => {
  const AT_3H_AGO = '2026-11-13T22:00:00.000Z'; // FETCHED の3時間前
  const AT_7H_AGO = '2026-11-13T18:00:00.000Z'; // FETCHED の7時間前
  const existingWithAudio = async (extra = {}) => {
    const id = await articleId('nhk', 'g1');
    return {
      [id]: {
        id, feed_id: 'nhk', title: 'old', link: 'https://example.com/g1',
        published_at: '2026-11-01T00:00:00.000Z', fetched_at: '2026-11-05T00:00:00.000Z',
        summary: '', author: '', audio_url: 'https://example.com/g1.mp3',
        audio_url_at: AT_3H_AGO, audio_stale: false, duration_sec: 321,
        play_pos: 10, is_read: false, read_at: '',
        ...extra,
      },
    };
  };

  it('新規の音声つきエントリは受け取り時刻を持ち、印は付かない', async () => {
    const [record] = await planUpserts({}, [entry('g1', { audioUrl: 'https://example.com/g1.mp3' })], FEED, FETCHED);
    expect(record.audio_url).toBe('https://example.com/g1.mp3');
    expect(record.audio_url_at).toBe(FETCHED);
    expect(record.audio_stale).toBe(false);
  });
  it('新鮮な enclosure が来たら URL と受け取り時刻を更新し、印を下ろす', async () => {
    const existing = await existingWithAudio({ audio_stale: true });
    const [record] = await planUpserts(existing, [entry('g1', { audioUrl: 'https://example.com/fresh.mp3', durationSec: 300 })], FEED, FETCHED);
    expect(record.audio_url).toBe('https://example.com/fresh.mp3');
    expect(record.audio_url_at).toBe(FETCHED);
    expect(record.audio_stale).toBe(false);
    expect(record.duration_sec).toBe(300);
  });
  it('enclosure が来なくても6時間未満なら URL を保持し、印を立てる (時刻と長さは保つ)', async () => {
    const existing = await existingWithAudio();
    const [record] = await planUpserts(existing, [entry('g1')], FEED, FETCHED);
    expect(record.audio_url).toBe('https://example.com/g1.mp3');
    expect(record.audio_url_at).toBe(AT_3H_AGO);
    expect(record.audio_stale).toBe(true);
    expect(record.duration_sec).toBe(321);
    expect(record.play_pos).toBe(10);
  });
  it('6時間以上経っていたら URL を消す', async () => {
    const existing = await existingWithAudio({ audio_url_at: AT_7H_AGO });
    const [record] = await planUpserts(existing, [entry('g1')], FEED, FETCHED);
    expect(record.audio_url).toBe('');
    expect(record.audio_url_at).toBe('');
    expect(record.audio_stale).toBe(false);
  });
  it('ちょうど6時間で消え、6時間未満では保持する (境界)', async () => {
    const just6h = await existingWithAudio({ audio_url_at: '2026-11-13T19:00:00.000Z' });
    const [dropped] = await planUpserts(just6h, [entry('g1')], FEED, FETCHED);
    expect(dropped.audio_url).toBe('');
    const justUnder = await existingWithAudio({ audio_url_at: '2026-11-13T19:00:00.001Z' });
    const [kept] = await planUpserts(justUnder, [entry('g1')], FEED, FETCHED);
    expect(kept.audio_url).toBe('https://example.com/g1.mp3');
    expect(kept.audio_stale).toBe(true);
  });
  it('受け取り時刻が無い旧データは、一度だけ猶予として今回の時刻で保持し印を立てる', async () => {
    const legacy = await existingWithAudio();
    delete legacy[Object.keys(legacy)[0]].audio_url_at;
    delete legacy[Object.keys(legacy)[0]].audio_stale;
    const [record] = await planUpserts(legacy, [entry('g1')], FEED, FETCHED);
    expect(record.audio_url).toBe('https://example.com/g1.mp3');
    expect(record.audio_url_at).toBe(FETCHED);
    expect(record.audio_stale).toBe(true);
    // 猶予は一度だけ: 次の取り込み (2時間後) では時刻は進まず保持され、
    // さらにその6時間後には消える。
    const later = '2026-11-14T03:00:00.000Z';
    const [kept] = await planUpserts({ [record.id]: record }, [entry('g1')], FEED, later);
    expect(kept.audio_url_at).toBe(FETCHED);
    expect(kept.audio_url).toBe('https://example.com/g1.mp3');
    const muchLater = '2026-11-14T08:00:00.000Z';
    const [gone] = await planUpserts({ [record.id]: kept }, [entry('g1')], FEED, muchLater);
    expect(gone.audio_url).toBe('');
  });
  it('もともと音声が無い記事は空のまま', async () => {
    const id = await articleId('nhk', 'g1');
    const existing = {
      [id]: {
        id, feed_id: 'nhk', title: 'old', link: 'https://example.com/g1',
        published_at: '', fetched_at: '', summary: '', author: '',
        audio_url: '', duration_sec: null, play_pos: 0, is_read: false, read_at: '',
      },
    };
    const [record] = await planUpserts(existing, [entry('g1')], FEED, FETCHED);
    expect(record.audio_url).toBe('');
    expect(record.audio_url_at).toBe('');
    expect(record.audio_stale).toBe(false);
  });
});

describe('articleRecordToView の音声の期限切れ', () => {
  const T0 = Date.parse('2026-11-14T00:00:00.000Z');
  const base = {
    id: 'v', feed_id: 'pod', title: 'ep', link: 'https://example.com/ep',
    published_at: '', fetched_at: '', summary: '', author: '',
    audio_url: 'https://example.com/ep.mp3',
    audio_url_at: '2026-11-14T00:00:00.000Z', audio_stale: true,
    duration_sec: 600, play_pos: 0, is_read: false, read_at: '',
  };
  it('6時間未満なら URL を保持し、印つきで出す', () => {
    const view = articleRecordToView(base, 'Pod', T0 + 5 * 60 * 60 * 1000);
    expect(view.audioUrl).toBe('https://example.com/ep.mp3');
    expect(view.audioStale).toBe(true);
    expect(view.audioUrlAt).toBe('2026-11-14T00:00:00.000Z');
  });
  it('6時間以上なら、更新を待たずに音声なしとして扱う', () => {
    const view = articleRecordToView(base, 'Pod', T0 + 6 * 60 * 60 * 1000);
    expect(view.audioUrl).toBe('');
    expect(view.audioStale).toBe(false);
    expect(view.audioUrlAt).toBe('');
  });
  it('受け取り時刻が無い旧レコードは、印の有無だけがそのまま出る', () => {
    const legacy = { ...base };
    delete legacy.audio_url_at;
    delete legacy.audio_stale;
    const view = articleRecordToView(legacy, 'Pod', T0 + 24 * 60 * 60 * 1000);
    expect(view.audioUrl).toBe('https://example.com/ep.mp3');
    expect(view.audioStale).toBe(false);
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
  it('音声フィールドを持つレコードはそのまま表示用へ渡る', () => {
    const view = articleRecordToView({
      id: 'p', feed_id: 'pod', title: 'ep', link: 'https://example.com/ep',
      published_at: '', fetched_at: '', summary: '', author: '',
      audio_url: 'https://example.com/ep.mp3', duration_sec: 600, play_pos: 42,
      is_read: false, read_at: '',
    }, 'Pod');
    expect(view.audioUrl).toBe('https://example.com/ep.mp3');
    expect(view.durationSec).toBe(600);
    expect(view.playPos).toBe(42);
  });
  it('レコードの全文は表示用にも渡り、無いレコードでは空文字になる', () => {
    const base = {
      id: 'c', feed_id: 'nhk', title: 't', link: 'https://example.com',
      published_at: '', fetched_at: '', summary: 's', author: '',
      is_read: false, read_at: '',
    };
    expect(articleRecordToView({ ...base, content: '全文' }, 'NHK').content).toBe('全文');
    expect(articleRecordToView(base, 'NHK').content).toBe('');
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
      summary: 's', content: '', author: 'a', audioUrl: '', audioUrlAt: '', audioStale: false,
      durationSec: null, playPos: 0, isRead: true, starred: false, starState: '',
    });
  });
});

describe('planFeedRekey (フィードIDのハッシュ化の付け替え計画)', () => {
  const OLD = 'nhk';
  const URL = 'https://www3.nhk.or.jp/rss/news/cat0.xml';

  it('guid がリンクと同じ記事は ID を計算し直して付け替え、状態を保つ', async () => {
    const newId = await feedIdFromUrl(URL);
    const link = 'https://example.com/a/1';
    const record = {
      id: await articleId(OLD, link), feed_id: OLD, title: 't', link,
      published_at: '2026-11-13T00:00:00.000Z', fetched_at: '2026-11-14T00:00:00.000Z',
      summary: '', author: '', is_read: true, read_at: '2026-11-14T01:00:00.000Z', play_pos: 0,
    };
    const plan = await planFeedRekey([record], { [OLD]: newId });
    expect(plan.deletes).toEqual([record.id]);
    expect(plan.staged).toEqual([]);
    expect(plan.puts).toEqual([{ ...record, id: await articleId(newId, link), feed_id: newId }]);
  });

  it('guid がリンクと違う記事 (YouTube) は状態だけを退避し、旧レコードは消す', async () => {
    const newId = await feedIdFromUrl('https://www.youtube.com/feeds/videos.xml?channel_id=UCx');
    const link = 'https://www.youtube.com/watch?v=vid1';
    const record = {
      id: await articleId('yt-x', 'vid1'), feed_id: 'yt-x', title: 'v', link,
      published_at: '2026-11-13T00:00:00.000Z', fetched_at: '2026-11-10T00:00:00.000Z',
      summary: '', author: '', is_read: true, read_at: '2026-11-12T00:00:00.000Z', play_pos: 77,
    };
    const plan = await planFeedRekey([record], { 'yt-x': newId });
    expect(plan.puts).toEqual([]);
    expect(plan.deletes).toEqual([record.id]);
    expect(plan.staged).toEqual([{
      feedId: newId,
      link,
      state: {
        is_read: true,
        read_at: '2026-11-12T00:00:00.000Z',
        play_pos: 77,
        fetched_at: '2026-11-10T00:00:00.000Z',
      },
    }]);
  });

  it('対応表に無いフィードと付け替え済みのレコードには触らない', async () => {
    const other = { id: 'keep-1', feed_id: 'other', link: 'https://example.com/x' };
    const done = { id: 'keep-2', feed_id: 'already-new', link: 'https://example.com/y' };
    const plan = await planFeedRekey([other, done], { nhk: 'new-id' });
    expect(plan).toEqual({ puts: [], deletes: [], staged: [] });
  });
});

describe('planYouTubeChannelPairs (YouTube URL 形式変更の対応付け)', () => {
  const UC_A = 'UCxNfaRC6MbAnwSR1Dqqv69A';
  const UC_B = 'UCgM7BYX7KYMEYfBnZ60OIcw';
  const legacy = (uc) => `https://www.youtube.com/feeds/videos.xml?channel_id=${uc}`;
  const channel = (uc) => `https://www.youtube.com/channel/${uc}`;
  const feed = async (url) => ({ id: await feedIdFromUrl(url), url });

  it('同じチャンネルの旧形式と新形式を対応付ける', async () => {
    const cached = [await feed(legacy(UC_A)), await feed('https://example.com/rss')];
    const server = [await feed(channel(UC_A)), await feed('https://example.com/rss')];
    const plan = planYouTubeChannelPairs(cached, server);
    expect(plan.complete).toBe(true);
    expect(plan.idMap).toEqual({ [cached[0].id]: server[0].id });
  });

  it('チャンネルが違えば対応付けない', async () => {
    const cached = [await feed(legacy(UC_A))];
    const server = [await feed(channel(UC_B))];
    const plan = planYouTubeChannelPairs(cached, server);
    expect(plan.idMap).toEqual({});
    // サーバー一覧にそのチャンネル自体が無いので、完了は妨げない。
    expect(plan.complete).toBe(true);
  });

  it('サーバー側がまだ旧形式の間は対応付けず、完了にもしない', async () => {
    const cached = [await feed(legacy(UC_A))];
    const server = [await feed(legacy(UC_A))];
    const plan = planYouTubeChannelPairs(cached, server);
    expect(plan.idMap).toEqual({});
    expect(plan.complete).toBe(false);
  });

  it('キャッシュが既に新形式なら対象外で、完了を妨げない', async () => {
    const cached = [await feed(channel(UC_A))];
    const server = [await feed(channel(UC_A))];
    const plan = planYouTubeChannelPairs(cached, server);
    expect(plan).toEqual({ idMap: {}, complete: true });
  });

  it('旧形式が無ければ何もしない (complete)', async () => {
    const plan = planYouTubeChannelPairs(
      [{ id: 'nhk', url: 'https://example.com/rss' }],
      [{ id: 'nhk', url: 'https://example.com/rss' }]
    );
    expect(plan).toEqual({ idMap: {}, complete: true });
    expect(planYouTubeChannelPairs([], [])).toEqual({ idMap: {}, complete: true });
  });

  it('一部だけ新形式でも、旧形式が残るチャンネルがある間は完了にしない', async () => {
    const cached = [await feed(legacy(UC_A)), await feed(legacy(UC_B))];
    const server = [await feed(channel(UC_A)), await feed(legacy(UC_B))];
    const plan = planYouTubeChannelPairs(cached, server);
    expect(plan.idMap).toEqual({ [cached[0].id]: server[0].id });
    expect(plan.complete).toBe(false);
  });
});

describe('planYouTubeArticleRekey (YouTube 記事の付け替え計画)', () => {
  const OLD = 'old-feed-id';
  const NEW = 'new-feed-id';
  const WATCH = 'https://www.youtube.com/watch?v=vid1';

  it('リンクから動画 ID が取れる記事は ID を計算し直して付け替え、状態と音声情報を保つ', async () => {
    const record = {
      id: await articleId(OLD, 'vid1'), feed_id: OLD, title: 'v', link: WATCH,
      published_at: '2026-11-13T00:00:00.000Z', fetched_at: '2026-11-10T00:00:00.000Z',
      summary: 's', author: 'a', audio_url: 'https://example.com/v.mp3', duration_sec: 321,
      is_read: true, read_at: '2026-11-12T00:00:00.000Z', play_pos: 77,
    };
    const plan = await planYouTubeArticleRekey([record], { [OLD]: NEW });
    expect(plan.deletes).toEqual([record.id]);
    expect(plan.staged).toEqual([]);
    expect(plan.puts).toEqual([{ ...record, id: await articleId(NEW, 'vid1'), feed_id: NEW }]);
    expect(plan.puts[0].is_read).toBe(true);
    expect(plan.puts[0].play_pos).toBe(77);
    expect(plan.puts[0].audio_url).toBe('https://example.com/v.mp3');
    expect(plan.puts[0].duration_sec).toBe(321);
  });

  it('動画 ID が取れないリンクの記事は状態だけを退避し、旧レコードは消す', async () => {
    const link = 'https://example.com/not-a-video';
    const record = {
      id: await articleId(OLD, 'whatever'), feed_id: OLD, title: 'x', link,
      published_at: '2026-11-13T00:00:00.000Z', fetched_at: '2026-11-10T00:00:00.000Z',
      summary: '', author: '', is_read: true, read_at: '2026-11-12T00:00:00.000Z', play_pos: 5,
    };
    const plan = await planYouTubeArticleRekey([record], { [OLD]: NEW });
    expect(plan.puts).toEqual([]);
    expect(plan.deletes).toEqual([record.id]);
    expect(plan.staged).toEqual([{
      feedId: NEW,
      link,
      state: {
        is_read: true,
        read_at: '2026-11-12T00:00:00.000Z',
        play_pos: 5,
        fetched_at: '2026-11-10T00:00:00.000Z',
      },
    }]);
  });

  it('対応表に無いフィードと付け替え済みのレコードには触らない', async () => {
    const other = { id: 'keep-1', feed_id: 'other', link: WATCH };
    const done = { id: 'keep-2', feed_id: NEW, link: WATCH };
    const plan = await planYouTubeArticleRekey([other, done], { [OLD]: NEW });
    expect(plan).toEqual({ puts: [], deletes: [], staged: [] });
  });
});

describe('付け替え状態のマップ操作', () => {
  const state = { is_read: true, read_at: '2026-11-12T00:00:00.000Z', play_pos: 5, fetched_at: '2026-11-10T00:00:00.000Z' };

  it('mergeTransferredState はキー (新ID＋リンク) で合体し、同じキーは上書きする', () => {
    const merged = mergeTransferredState(null, [{ feedId: 'f1', link: 'https://e/1', state }]);
    expect(merged).toEqual({ [transferKey('f1', 'https://e/1')]: state });
    const again = mergeTransferredState(merged, [{ feedId: 'f1', link: 'https://e/1', state: { ...state, play_pos: 9 } }]);
    expect(again[transferKey('f1', 'https://e/1')].play_pos).toBe(9);
  });

  it('applyTransferredState は新規レコードへだけ状態を戻し、消費したキーを返す', () => {
    const transfer = { [transferKey('f1', 'https://e/1')]: state };
    const fresh = { id: 'new-1', feed_id: 'f1', link: 'https://e/1', is_read: false, read_at: '', play_pos: 0, fetched_at: '2026-11-14T00:00:00.000Z' };
    const existing = { id: 'new-2', feed_id: 'f1', link: 'https://e/1', is_read: false, read_at: '', play_pos: 0, fetched_at: '2026-11-14T00:00:00.000Z' };
    const { records, consumedKeys } = applyTransferredState(
      [fresh, existing], transfer, 'f1', { 'new-2': existing }
    );
    expect(records[0]).toEqual({
      ...fresh, is_read: true, read_at: state.read_at, play_pos: 5, fetched_at: state.fetched_at,
    });
    // 既にローカルにあるレコードは退避状態で上書きしない。
    expect(records[1]).toBe(existing);
    expect(consumedKeys).toEqual([transferKey('f1', 'https://e/1')]);
  });

  it('pruneTransferredState は残すフィード分だけを返す', () => {
    const transfer = {
      [transferKey('f1', 'https://e/1')]: state,
      [transferKey('f2', 'https://e/2')]: state,
    };
    expect(Object.keys(pruneTransferredState(transfer, new Set(['f2']))))
      .toEqual([transferKey('f2', 'https://e/2')]);
    expect(pruneTransferredState(transfer, new Set())).toEqual({});
    expect(pruneTransferredState(null, new Set(['f1']))).toEqual({});
  });
});

describe('planSyncDeletions', () => {
  const rec = (id, feed_id = 'cal') => ({ id, feed_id, title: id });

  it('取得集合に無い、そのフィードの記事だけを消す対象にする', () => {
    const articles = [rec('a'), rec('b'), rec('c'), rec('z', 'other')];
    const plan = planSyncDeletions(articles, 'cal', ['a', 'c']);
    expect(plan).toEqual({ deleteIds: ['b'], blocked: false, candidates: 1 });
  });

  it('取得集合が空なら同期しない (空は取得異常と区別できない)', () => {
    const plan = planSyncDeletions([rec('a')], 'cal', []);
    expect(plan).toEqual({ deleteIds: [], blocked: false, candidates: 0 });
  });

  it('削除候補が上限を超えたら blocked にして何も消さない', () => {
    const articles = [rec('a'), rec('b'), rec('c'), rec('d')];
    const plan = planSyncDeletions(articles, 'cal', ['a'], { maxDeletions: 2 });
    expect(plan).toEqual({ deleteIds: [], blocked: true, candidates: 3 });
  });

  it('ID の無い要素や他フィードの記事は数えない', () => {
    const articles = [null, { feed_id: 'cal' }, rec('a'), rec('b', 'other')];
    const plan = planSyncDeletions(articles, 'cal', ['a']);
    expect(plan).toEqual({ deleteIds: [], blocked: false, candidates: 0 });
  });
});
