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
} from '../src/lib/localDb.js';

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
