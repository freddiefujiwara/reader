// 端末ローカルの記事・フィード・既読の保存 (IndexedDB)。
// v2 では表示と既読をすべてローカルでまかなう。DB は薄く保ち、
// 判定ロジックは純関数の planUpserts / planLocalPrune / planOrphanArticles に
// 分けて単体テストで固定する。
// DB 名はセッションキー (reader:session:v1 / :staging) と同じ環境分けにする。
import { isStagingBuild } from '../staging-banner.js';
import { articleId } from './articleId.js';

export const RETENTION_DAYS = 60;
export const MAX_ARTICLES = 5000;

export function localDbName(env) {
  return isStagingBuild(env) ? 'reader:db:v1:staging' : 'reader:db:v1';
}

/* ---- 純粋な計画関数 (IndexedDB に触れない) ---- */

// 取得エントリから、IndexedDB へ put する記事レコードを組み立てる。
// 新規記事は未読。既存記事は既読状態 (is_read / read_at) と取り込み日時
// (fetched_at: 経過日数の起点) を保ち、メタデータだけ最新化する。
export async function planUpserts(existingById, entries, feed, fetchedAtIso) {
  const records = [];
  const seen = new Set();
  for (const entry of entries || []) {
    const key = entry.guid || entry.link;
    if (!key || !entry.link) continue;
    const id = await articleId(feed.id, key);
    if (seen.has(id)) continue;
    seen.add(id);
    const prev = existingById ? existingById[id] : null;
    if (prev) {
      records.push({
        ...prev,
        title: entry.title,
        link: entry.link,
        published_at: entry.publishedAt || prev.published_at || '',
        summary: entry.summary || '',
        author: entry.author || '',
        audio_url: entry.audioUrl || '',
        duration_sec: entry.durationSec ?? null,
      });
    } else {
      records.push({
        id,
        feed_id: feed.id,
        title: entry.title,
        link: entry.link,
        published_at: entry.publishedAt || '',
        fetched_at: fetchedAtIso,
        summary: entry.summary || '',
        author: entry.author || '',
        audio_url: entry.audioUrl || '',
        duration_sec: entry.durationSec ?? null,
        play_pos: 0,
        is_read: false,
        read_at: '',
      });
    }
  }
  return records;
}

// ローカルの保持ルール: 既読記事は「取り込んでから60日」を過ぎたら消す。
// 合計が上限を超える場合は、新しい順に残して古い既読から消す。
// 未読は日数でも件数でも消さない (サーバー側 prunePlan と同じ考え方)。
export function planLocalPrune(articles, nowIso, { retentionDays = RETENTION_DAYS, maxArticles = MAX_ARTICLES } = {}) {
  const now = nowIso ? Date.parse(nowIso) : Date.now();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const sorted = (articles || []).slice().sort((a, b) => articleTime(b) - articleTime(a));
  const keepRank = {};
  sorted.forEach((a, idx) => { keepRank[a.id] = idx < maxArticles; });
  const ids = [];
  (articles || []).forEach((a) => {
    if (!a.is_read) return;
    const t = Date.parse(a.fetched_at || a.published_at || '') || 0;
    const tooOld = t > 0 && now - t > retentionMs;
    if (tooOld || !keepRank[a.id]) ids.push(a.id);
  });
  return ids;
}

function articleTime(a) {
  return Date.parse(a.published_at || a.fetched_at || '') || 0;
}

// フィード一覧から消えたフィードの記事 (残しておくと行き場のない記事になる)。
export function planOrphanArticles(articles, feedIds) {
  const live = new Set(feedIds || []);
  return (articles || []).filter((a) => !live.has(a.feed_id)).map((a) => a.id);
}

// DB レコードを表示用 (listState が扱う camelCase 形) へ変換する。
export function articleRecordToView(record, feedTitle) {
  return {
    id: record.id,
    feedId: record.feed_id,
    feedTitle: feedTitle || '',
    title: record.title,
    link: record.link,
    publishedAt: record.published_at || '',
    fetchedAt: record.fetched_at || '',
    summary: record.summary || '',
    author: record.author || '',
    audioUrl: record.audio_url || '',
    durationSec: record.duration_sec ?? null,
    playPos: record.play_pos || 0,
    isRead: !!record.is_read,
  };
}

/* ---- IndexedDB の薄いラッパー ---- */

let dbPromise = null;

export function openLocalDb(env) {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(localDbName(env), 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        const articles = db.createObjectStore('articles', { keyPath: 'id' });
        articles.createIndex('feed_id', 'feed_id', { unique: false });
        articles.createIndex('published_at', 'published_at', { unique: false });
        db.createObjectStore('feeds', { keyPath: 'id' });
        db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('indexeddb_open_failed'));
    });
  }
  return dbPromise;
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexeddb_request_failed'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('indexeddb_tx_failed'));
    tx.onabort = () => reject(tx.error || new Error('indexeddb_tx_aborted'));
  });
}

async function getAll(storeName) {
  const db = await openLocalDb();
  return requestToPromise(db.transaction(storeName, 'readonly').objectStore(storeName).getAll());
}

async function putAll(storeName, records) {
  if (!records.length) return;
  const db = await openLocalDb();
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  records.forEach((r) => store.put(r));
  await txDone(tx);
}

async function deleteByIds(storeName, ids) {
  if (!ids.length) return;
  const db = await openLocalDb();
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  ids.forEach((id) => store.delete(id));
  await txDone(tx);
}

export function loadLocalArticles() {
  return getAll('articles');
}

export function putLocalArticles(records) {
  return putAll('articles', records);
}

export function deleteLocalArticles(ids) {
  return deleteByIds('articles', ids);
}

// 記事1件の既読を切り替える。対象が無ければ何もしない。
export async function setLocalArticleRead(id, isRead, readAtIso) {
  const db = await openLocalDb();
  const tx = db.transaction('articles', 'readwrite');
  const store = tx.objectStore('articles');
  const record = await requestToPromise(store.get(id));
  if (record) {
    record.is_read = !!isRead;
    record.read_at = isRead ? (readAtIso || '') : '';
    store.put(record);
  }
  await txDone(tx);
}

// まとめて既読化。ids のうち未読のものだけを書き換える。
export async function markLocalArticlesRead(ids, readAtIso) {
  if (!ids.length) return;
  const db = await openLocalDb();
  const tx = db.transaction('articles', 'readwrite');
  const store = tx.objectStore('articles');
  for (const id of ids) {
    const record = await requestToPromise(store.get(id));
    if (record && !record.is_read) {
      record.is_read = true;
      record.read_at = readAtIso || '';
      store.put(record);
    }
  }
  await txDone(tx);
}

// 再生位置 (秒) を保存する。対象が無ければ何もしない。
// レコードはオブジェクトごと保存する形なので、フィールド追加に
// DB のバージョン変更は要らない (索引は変えていない)。
export async function setLocalArticlePlayPos(id, posSec) {
  const db = await openLocalDb();
  const tx = db.transaction('articles', 'readwrite');
  const store = tx.objectStore('articles');
  const record = await requestToPromise(store.get(id));
  if (record) {
    record.play_pos = Number.isFinite(posSec) && posSec > 0 ? Math.floor(posSec) : 0;
    store.put(record);
  }
  await txDone(tx);
}

// 再生位置を消す (再生し終えたエピソード用)。
export function clearLocalArticlePlayPos(id) {
  return setLocalArticlePlayPos(id, 0);
}

// フィード一覧はサーバーの並び順が正本。sortOrder を付けて保存し、
// 読み出し時に元の順序へ戻す (keyPath の辞書順にはしない)。
export async function saveLocalFeeds(feeds) {
  const db = await openLocalDb();
  const tx = db.transaction('feeds', 'readwrite');
  const store = tx.objectStore('feeds');
  store.clear();
  (feeds || []).forEach((f, i) => store.put({ ...f, sortOrder: i }));
  await txDone(tx);
}

export async function loadLocalFeeds() {
  const rows = await getAll('feeds');
  return rows
    .slice()
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .map(({ sortOrder, ...feed }) => feed);
}

export async function getLocalMeta(key) {
  const db = await openLocalDb();
  const row = await requestToPromise(db.transaction('meta', 'readonly').objectStore('meta').get(key));
  return row ? row.value : undefined;
}

export async function setLocalMeta(key, value) {
  const db = await openLocalDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  await txDone(tx);
}
