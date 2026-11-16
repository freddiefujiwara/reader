import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import {
  localDbName,
  closeLocalDb,
  saveLocalFeeds,
  loadLocalFeeds,
  putLocalArticles,
  loadLocalArticles,
  deleteLocalArticles,
  setLocalArticleRead,
  setLocalArticlePlayPos,
  clearLocalArticlePlayPos,
  clearLocalArticleAudio,
  markLocalArticlesRead,
  ingestFeedArticles,
  getLocalMeta,
  setLocalMeta,
  planUpserts,
  applyTransferredState,
  migrateFeedHashIds,
  migrateYouTubeChannelUrlIds,
  transferKey,
  FEED_HASH_MIGRATED_KEY,
  FEED_HASH_TRANSFER_KEY,
  YT_CHANNEL_URL_MIGRATED_KEY,
} from '../src/lib/localDb.js';
import { articleId } from '../src/lib/articleId.js';
import { feedIdFromUrl } from '../src/lib/feedHash.js';

// IndexedDB ラッパー層の検証 (計画関数は localPlan.test.js 側)。
// jsdom には IndexedDB が無いため fake-indexeddb で代替する。

const rec = (id, extra = {}) => ({
  id, feed_id: 'nhk', title: id, link: `https://example.com/${id}`,
  published_at: '2026-11-13T00:00:00.000Z', fetched_at: '2026-11-14T00:00:00.000Z',
  summary: '', author: '', is_read: false, read_at: '',
  ...extra,
});

describe('localDbName', () => {
  it('本番とステージングで DB 名が分かれる', () => {
    expect(localDbName({})).toBe('reader:db:v1');
    expect(localDbName({ VITE_STAGING: '1' })).toBe('reader:db:v1:staging');
    expect(localDbName({})).not.toBe(localDbName({ VITE_STAGING: '1' }));
  });
});

describe('フィードの保存と読み戻し', () => {
  it('保存した順序のまま読み戻し、sortOrder は表に出ない', async () => {
    const feeds = [
      { id: 'zenn', title: 'Zenn', url: 'https://example.com/zenn' },
      { id: 'asahi', title: '朝日', url: 'https://example.com/asahi' },
      { id: 'nhk', title: 'NHK', url: 'https://example.com/nhk' },
    ];
    await saveLocalFeeds(feeds);
    const loaded = await loadLocalFeeds();
    // keyPath の辞書順 (asahi, nhk, zenn) ではなく保存順で返る。
    expect(loaded.map((f) => f.id)).toEqual(['zenn', 'asahi', 'nhk']);
    expect(loaded[0]).toEqual(feeds[0]);
    expect(loaded.every((f) => !('sortOrder' in f))).toBe(true);
  });
});

describe('既読の書き換え', () => {
  it('markLocalArticlesRead は未読だけを既読化し、既読の read_at は保つ', async () => {
    await putLocalArticles([
      rec('mark-unread'),
      rec('mark-read', { is_read: true, read_at: '2026-11-01T00:00:00.000Z' }),
    ]);
    await markLocalArticlesRead(['mark-unread', 'mark-read'], '2026-11-14T03:00:00.000Z');
    const all = await loadLocalArticles();
    const newly = all.find((a) => a.id === 'mark-unread');
    const already = all.find((a) => a.id === 'mark-read');
    expect(newly.is_read).toBe(true);
    expect(newly.read_at).toBe('2026-11-14T03:00:00.000Z');
    expect(already.read_at).toBe('2026-11-01T00:00:00.000Z');
    await deleteLocalArticles(['mark-unread', 'mark-read']);
  });
  it('setLocalArticleRead は対象が無ければ何もしない', async () => {
    await setLocalArticleRead('no-such-article', true, '2026-11-14T03:00:00.000Z');
    const all = await loadLocalArticles();
    expect(all.some((a) => a.id === 'no-such-article')).toBe(false);
  });
  it('setLocalArticleRead は既存記事の状態を切り替える', async () => {
    await putLocalArticles([rec('toggle-1')]);
    await setLocalArticleRead('toggle-1', true, '2026-11-14T04:00:00.000Z');
    let row = (await loadLocalArticles()).find((a) => a.id === 'toggle-1');
    expect(row.is_read).toBe(true);
    expect(row.read_at).toBe('2026-11-14T04:00:00.000Z');
    await setLocalArticleRead('toggle-1', false, '');
    row = (await loadLocalArticles()).find((a) => a.id === 'toggle-1');
    expect(row.is_read).toBe(false);
    expect(row.read_at).toBe('');
    await deleteLocalArticles(['toggle-1']);
  });
});

describe('再生位置の保存', () => {
  it('setLocalArticlePlayPos は秒を切り捨てて保存し、clear で 0 に戻る', async () => {
    await putLocalArticles([rec('pos-1')]);
    await setLocalArticlePlayPos('pos-1', 123.9);
    let row = (await loadLocalArticles()).find((a) => a.id === 'pos-1');
    expect(row.play_pos).toBe(123);
    await clearLocalArticlePlayPos('pos-1');
    row = (await loadLocalArticles()).find((a) => a.id === 'pos-1');
    expect(row.play_pos).toBe(0);
    await deleteLocalArticles(['pos-1']);
  });
  it('対象が無ければ何もしない', async () => {
    await setLocalArticlePlayPos('no-such-episode', 60);
    const all = await loadLocalArticles();
    expect(all.some((a) => a.id === 'no-such-episode')).toBe(false);
  });
});

describe('音声URLの取り消し', () => {
  it('clearLocalArticleAudio は URL・受け取り時刻・印だけを消し、他の状態は保つ', async () => {
    await putLocalArticles([rec('aud-1', {
      audio_url: 'https://example.com/aud-1.mp3',
      audio_url_at: '2026-11-14T00:00:00.000Z',
      audio_stale: true,
      duration_sec: 600,
      play_pos: 30,
      is_read: true,
      read_at: '2026-11-14T01:00:00.000Z',
    })]);
    await clearLocalArticleAudio('aud-1');
    const row = (await loadLocalArticles()).find((a) => a.id === 'aud-1');
    expect(row.audio_url).toBe('');
    expect(row.audio_url_at).toBe('');
    expect(row.audio_stale).toBe(false);
    expect(row.duration_sec).toBe(600);
    expect(row.play_pos).toBe(30);
    expect(row.is_read).toBe(true);
    await deleteLocalArticles(['aud-1']);
  });
  it('対象が無ければ何もしない', async () => {
    await clearLocalArticleAudio('no-such-episode');
    const all = await loadLocalArticles();
    expect(all.some((a) => a.id === 'no-such-episode')).toBe(false);
  });
});

describe('ingestFeedArticles (取り込みは書き込み時点で最新状態とマージする)', () => {
  const FEED = { id: 'ingest-feed', title: 'Ingest' };
  const FETCHED1 = '2026-11-14T01:00:00.000Z';
  const FETCHED2 = '2026-11-14T06:00:00.000Z';
  const READ_AT = '2026-11-14T02:00:00.000Z';
  const makeEntries = (titlePrefix = 'title') => ['a1', 'a2', 'a3'].map((g) => ({
    guid: g,
    title: `${titlePrefix}-${g}`,
    link: `https://example.com/${g}`,
    publishedAt: '2026-11-13T00:00:00.000Z',
    summary: '',
    author: '',
    audioUrl: `https://example.com/${g}.mp3`,
    durationSec: 600,
  }));
  const idOf = (g) => articleId(FEED.id, g);
  const rowsOfFeed = async () =>
    (await loadLocalArticles()).filter((a) => a.feed_id === FEED.id);
  const cleanup = async () => {
    const rows = await rowsOfFeed();
    await deleteLocalArticles(rows.map((a) => a.id));
  };

  it('取り込み後に付けた既読は、次の取り込みで巻き戻らない', async () => {
    await cleanup();
    await ingestFeedArticles(FEED, makeEntries(), FETCHED1, null);
    let rows = await rowsOfFeed();
    expect(rows.length).toBe(3);
    expect(rows.every((a) => !a.is_read)).toBe(true);

    // 取得の合間に「すべて既読」が走った状況を再現する。
    await markLocalArticlesRead(rows.map((a) => a.id), READ_AT);

    await ingestFeedArticles(FEED, makeEntries(), FETCHED2, null);
    rows = await rowsOfFeed();
    expect(rows.length).toBe(3);
    expect(rows.every((a) => a.is_read)).toBe(true);
    expect(rows.every((a) => a.read_at === READ_AT)).toBe(true);
    await cleanup();
  });

  it('取り込み後に保存した再生位置は、次の取り込みで巻き戻らない', async () => {
    await cleanup();
    await ingestFeedArticles(FEED, makeEntries(), FETCHED1, null);
    const target = await idOf('a1');
    await setLocalArticlePlayPos(target, 321);

    // メタデータが変わったエントリで取り込み直しても、状態は保たれる。
    await ingestFeedArticles(FEED, makeEntries('renamed'), FETCHED2, null);
    const rows = await rowsOfFeed();
    const row = rows.find((a) => a.id === target);
    expect(row.play_pos).toBe(321);
    expect(row.title).toBe('renamed-a1');
    expect(rows.filter((a) => a.id !== target).every((a) => a.play_pos === 0)).toBe(true);
    await cleanup();
  });

  it('既読化→取り込み→既読化の順でも、既読は既読のまま保たれる', async () => {
    await cleanup();
    await ingestFeedArticles(FEED, makeEntries(), FETCHED1, null);
    const first = await idOf('a1');
    const second = await idOf('a2');
    await markLocalArticlesRead([first], READ_AT);
    await ingestFeedArticles(FEED, makeEntries(), FETCHED2, null);
    await markLocalArticlesRead([second], READ_AT);
    await ingestFeedArticles(FEED, makeEntries(), FETCHED2, null);
    const rows = await rowsOfFeed();
    expect(rows.find((a) => a.id === first).is_read).toBe(true);
    expect(rows.find((a) => a.id === second).is_read).toBe(true);
    expect(rows.find((a) => a.id !== first && a.id !== second).is_read).toBe(false);
    await cleanup();
  });

  it('付け替え状態は新規レコードへだけ戻り、既存レコードは上書きしない', async () => {
    await cleanup();
    const transfer = {
      [transferKey(FEED.id, 'https://example.com/a1')]: {
        is_read: true, read_at: '2026-11-12T00:00:00.000Z',
        play_pos: 77, fetched_at: '2026-11-10T00:00:00.000Z',
      },
    };
    const { consumedKeys } = await ingestFeedArticles(FEED, makeEntries(), FETCHED1, transfer);
    expect(consumedKeys).toEqual([transferKey(FEED.id, 'https://example.com/a1')]);
    let rows = await rowsOfFeed();
    const restored = rows.find((a) => a.link === 'https://example.com/a1');
    expect(restored.is_read).toBe(true);
    expect(restored.play_pos).toBe(77);
    expect(restored.fetched_at).toBe('2026-11-10T00:00:00.000Z');

    // 同じマップが残っていても、既存レコードの新しい状態は守られる。
    await setLocalArticleRead(restored.id, false, '');
    const again = await ingestFeedArticles(FEED, makeEntries(), FETCHED2, transfer);
    expect(again.consumedKeys).toEqual([]);
    rows = await rowsOfFeed();
    expect(rows.find((a) => a.id === restored.id).is_read).toBe(false);
    await cleanup();
  });
});

describe('メタ情報', () => {
  it('setLocalMeta / getLocalMeta の往復', async () => {
    await setLocalMeta('statesImportedV2', true);
    await expect(getLocalMeta('statesImportedV2')).resolves.toBe(true);
    await setLocalMeta('someCount', 42);
    await expect(getLocalMeta('someCount')).resolves.toBe(42);
    await expect(getLocalMeta('never-set')).resolves.toBeUndefined();
  });
});

describe('フィードIDのハッシュ化の移行 (migrateFeedHashIds)', () => {
  const NHK_URL = 'https://www3.nhk.or.jp/rss/news/cat0.xml';
  const YT_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCx';
  const LINK = 'https://example.com/a/1';
  const WATCH = 'https://www.youtube.com/watch?v=vid1';

  it('旧IDの記事を付け替え、既読と再生位置を引き継ぎ、二度目は走らない', async () => {
    const newNhk = await feedIdFromUrl(NHK_URL);
    const newYt = await feedIdFromUrl(YT_URL);
    const directId = await articleId('nhk', LINK);
    const stagedId = await articleId('yt-x', 'vid1');
    await saveLocalFeeds([
      { id: 'nhk', title: 'NHK', url: NHK_URL },
      { id: 'yt-x', title: 'YT', url: YT_URL },
    ]);
    await putLocalArticles([
      rec(directId, {
        feed_id: 'nhk', link: LINK, is_read: true,
        read_at: '2026-11-14T01:00:00.000Z', play_pos: 33,
      }),
      rec(stagedId, {
        feed_id: 'yt-x', link: WATCH, is_read: true,
        read_at: '2026-11-12T00:00:00.000Z', play_pos: 77,
        fetched_at: '2026-11-10T00:00:00.000Z',
      }),
    ]);

    const result = await migrateFeedHashIds();
    expect(result).toEqual({ migrated: true, rekeyed: 1, staged: 1 });
    await expect(getLocalMeta(FEED_HASH_MIGRATED_KEY)).resolves.toBe(true);

    // guid がリンクと同じ記事は、その場で新しい ID へ付け替わる。
    let all = await loadLocalArticles();
    const moved = all.find((a) => a.feed_id === newNhk);
    expect(moved).toBeTruthy();
    expect(moved.id).toBe(await articleId(newNhk, LINK));
    expect(moved.is_read).toBe(true);
    expect(moved.read_at).toBe('2026-11-14T01:00:00.000Z');
    expect(moved.play_pos).toBe(33);
    expect(all.some((a) => a.id === directId)).toBe(false);

    // YouTube の記事は旧レコードが消え、状態が付け替えマップへ退避する。
    expect(all.some((a) => a.id === stagedId)).toBe(false);
    const transfer = await getLocalMeta(FEED_HASH_TRANSFER_KEY);
    expect(transfer).toEqual({
      [transferKey(newYt, WATCH)]: {
        is_read: true, read_at: '2026-11-12T00:00:00.000Z',
        play_pos: 77, fetched_at: '2026-11-10T00:00:00.000Z',
      },
    });

    // 再取得の取り込みで、退避した状態が新しい記事へ戻る (重複は出ない)。
    const byId = {};
    all.forEach((r) => { byId[r.id] = r; });
    const entries = [{
      guid: 'vid1', title: 'v', link: WATCH,
      publishedAt: '2026-11-13T00:00:00.000Z', summary: '', author: '',
      audioUrl: '', durationSec: null,
    }];
    const planned = await planUpserts(byId, entries, { id: newYt }, '2026-11-14T05:00:00.000Z');
    const applied = applyTransferredState(planned, transfer, newYt, byId);
    expect(applied.consumedKeys).toEqual([transferKey(newYt, WATCH)]);
    await putLocalArticles(applied.records);
    all = await loadLocalArticles();
    const restored = all.filter((a) => a.feed_id === newYt);
    expect(restored.length).toBe(1);
    expect(restored[0].is_read).toBe(true);
    expect(restored[0].play_pos).toBe(77);
    expect(restored[0].fetched_at).toBe('2026-11-10T00:00:00.000Z');

    // フラグがあるので二度目は走らず、付け替えも繰り返さない。
    await expect(migrateFeedHashIds()).resolves.toEqual({ migrated: false });
    all = await loadLocalArticles();
    expect(all.filter((a) => a.feed_id === newNhk).length).toBe(1);
    expect(all.filter((a) => a.feed_id === newYt).length).toBe(1);

    // 後片付け (このファイルの他テストへ影響を残さない)。
    await deleteLocalArticles(all.map((a) => a.id));
    await saveLocalFeeds([]);
    await setLocalMeta(FEED_HASH_MIGRATED_KEY, undefined);
    await setLocalMeta(FEED_HASH_TRANSFER_KEY, undefined);
  });
});

describe('YouTube URL 形式変更の移行 (migrateYouTubeChannelUrlIds)', () => {
  const UC = 'UCxNfaRC6MbAnwSR1Dqqv69A';
  const LEGACY_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${UC}`;
  const CHANNEL_URL = `https://www.youtube.com/channel/${UC}`;
  const NHK_URL = 'https://www3.nhk.or.jp/rss/news/cat0.xml';
  const WATCH = 'https://www.youtube.com/watch?v=vid1';
  const WEIRD = 'https://example.com/not-a-video';

  it('サーバーが新形式を返してから付け替え、完了後は二度走らない', async () => {
    const oldId = await feedIdFromUrl(LEGACY_URL);
    const newId = await feedIdFromUrl(CHANNEL_URL);
    const nhkId = await feedIdFromUrl(NHK_URL);
    const videoArticleId = await articleId(oldId, 'vid1');
    const weirdArticleId = await articleId(oldId, 'mystery');
    const nhkArticleId = await articleId(nhkId, 'n1');
    await saveLocalFeeds([
      { id: oldId, title: 'YT', url: LEGACY_URL },
      { id: nhkId, title: 'NHK', url: NHK_URL },
    ]);
    await putLocalArticles([
      rec(videoArticleId, {
        feed_id: oldId, link: WATCH, is_read: true,
        read_at: '2026-11-12T00:00:00.000Z', play_pos: 77,
        audio_url: 'https://example.com/vid1.mp3', duration_sec: 321,
        fetched_at: '2026-11-10T00:00:00.000Z',
      }),
      rec(weirdArticleId, {
        feed_id: oldId, link: WEIRD, is_read: true,
        read_at: '2026-11-12T00:00:00.000Z', play_pos: 5,
        fetched_at: '2026-11-10T00:00:00.000Z',
      }),
      rec(nhkArticleId, { feed_id: nhkId, link: 'https://example.com/n1' }),
    ]);
    const nhkFeed = { id: nhkId, title: 'NHK', url: NHK_URL };

    // サーバー側がまだ旧形式の間は、付け替えもフラグも起きない。
    const before = await migrateYouTubeChannelUrlIds([
      { id: oldId, title: 'YT', url: LEGACY_URL }, nhkFeed,
    ]);
    expect(before.complete).toBe(false);
    await expect(getLocalMeta(YT_CHANNEL_URL_MIGRATED_KEY)).resolves.toBeUndefined();
    let all = await loadLocalArticles();
    expect(all.some((a) => a.id === videoArticleId)).toBe(true);

    // サーバーが新形式を返し始めたら付け替える。
    const result = await migrateYouTubeChannelUrlIds([
      { id: newId, title: 'YT', url: CHANNEL_URL }, nhkFeed,
    ]);
    expect(result).toEqual({ migrated: true, complete: true, rekeyed: 1, staged: 1 });
    await expect(getLocalMeta(YT_CHANNEL_URL_MIGRATED_KEY)).resolves.toBe(true);

    all = await loadLocalArticles();
    // 動画 ID が取れる記事は、その場で新しい ID へ。状態と音声情報も保つ。
    const moved = all.find((a) => a.feed_id === newId);
    expect(moved).toBeTruthy();
    expect(moved.id).toBe(await articleId(newId, 'vid1'));
    expect(moved.is_read).toBe(true);
    expect(moved.read_at).toBe('2026-11-12T00:00:00.000Z');
    expect(moved.play_pos).toBe(77);
    expect(moved.audio_url).toBe('https://example.com/vid1.mp3');
    expect(moved.duration_sec).toBe(321);
    expect(all.some((a) => a.id === videoArticleId)).toBe(false);
    // 動画 ID が取れない記事は旧レコードが消え、状態が付け替えマップへ。
    expect(all.some((a) => a.id === weirdArticleId)).toBe(false);
    const transfer = await getLocalMeta(FEED_HASH_TRANSFER_KEY);
    expect(transfer).toEqual({
      [transferKey(newId, WEIRD)]: {
        is_read: true, read_at: '2026-11-12T00:00:00.000Z',
        play_pos: 5, fetched_at: '2026-11-10T00:00:00.000Z',
      },
    });
    // YouTube 以外のフィードの記事には触らない。
    expect(all.some((a) => a.id === nhkArticleId && a.feed_id === nhkId)).toBe(true);

    // フラグがあるので二度目は走らない。
    await expect(migrateYouTubeChannelUrlIds([
      { id: newId, title: 'YT', url: CHANNEL_URL }, nhkFeed,
    ])).resolves.toEqual({ migrated: false });

    // 後片付け (このファイルの他テストへ影響を残さない)。
    await deleteLocalArticles((await loadLocalArticles()).map((a) => a.id));
    await saveLocalFeeds([]);
    await setLocalMeta(YT_CHANNEL_URL_MIGRATED_KEY, undefined);
    await setLocalMeta(FEED_HASH_TRANSFER_KEY, undefined);
  });

  it('旧形式のフィードが無ければ何もせず完了する', async () => {
    await saveLocalFeeds([{ id: 'nhk', title: 'NHK', url: NHK_URL }]);
    const result = await migrateYouTubeChannelUrlIds([{ id: 'nhk', title: 'NHK', url: NHK_URL }]);
    expect(result).toEqual({ migrated: true, complete: true, rekeyed: 0, staged: 0 });
    await expect(getLocalMeta(YT_CHANNEL_URL_MIGRATED_KEY)).resolves.toBe(true);
    await saveLocalFeeds([]);
    await setLocalMeta(YT_CHANNEL_URL_MIGRATED_KEY, undefined);
  });
});

describe('DB 接続のクローズ (closeLocalDb)', () => {
  it('閉じた後は開き直して、保存済みの内容を読み戻せる', async () => {
    await saveLocalFeeds([
      { id: 'zenn', title: 'Zenn', url: 'https://example.com/zenn' },
    ]);
    closeLocalDb();
    const loaded = await loadLocalFeeds();
    expect(loaded.map((f) => f.id)).toEqual(['zenn']);
  });

  it('開いていない状態で閉じてもエラーにならない', () => {
    closeLocalDb();
    expect(() => closeLocalDb()).not.toThrow();
  });
});
