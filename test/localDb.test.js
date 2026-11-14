import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import {
  localDbName,
  saveLocalFeeds,
  loadLocalFeeds,
  putLocalArticles,
  loadLocalArticles,
  deleteLocalArticles,
  setLocalArticleRead,
  setLocalArticlePlayPos,
  clearLocalArticlePlayPos,
  markLocalArticlesRead,
  getLocalMeta,
  setLocalMeta,
  planUpserts,
  applyTransferredState,
  migrateFeedHashIds,
  transferKey,
  FEED_HASH_MIGRATED_KEY,
  FEED_HASH_TRANSFER_KEY,
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
