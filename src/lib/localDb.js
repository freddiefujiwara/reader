// 端末ローカルの記事・フィード・既読の保存 (IndexedDB)。
// v2 では表示と既読をすべてローカルでまかなう。DB は薄く保ち、
// 判定ロジックは純関数の planUpserts / planLocalPrune / planOrphanArticles に
// 分けて単体テストで固定する。
// DB 名はセッションキー (reader:session:v1 / :staging) と同じ環境分けにする。
import { isStagingBuild } from '../staging-banner.js';
import { articleId } from './articleId.js';
import { feedIdFromUrl } from './feedHash.js';
import {
  isYouTubeFeedUrl,
  normalizePastGuard,
  normalizePruneExempt,
  youtubeChannelIdFromUrl,
  youtubePlaylistIdFromUrl,
  youtubeVideoIdFromLink,
} from './feedAdmin.js';

export const RETENTION_DAYS = 60;
export const MAX_ARTICLES = 5000;

// 墓標 (掃除で消した既読記事の ID と既読の記録) の保持。記事より
// ずっと小さいので、記事本体より長く・多く残す。
export const TOMBSTONE_RETENTION_DAYS = 180;
export const MAX_TOMBSTONES = 20000;

// 音声URLの保持期限。reader-gas は抽出から5時間以内のエントリにだけ
// enclosure を付けるが、ストリームURL自体は抽出から約6時間は有効な
// ことが多い。背景更新で enclosure が来なくなっても、最後に新鮮な
// enclosure を受け取ってから6時間までは URL を保持し (stale の印を
// 付ける)、6時間を超えたら消す。なおこの6時間は「最後に新鮮なURLを
// 受け取った時点」からの概算で、本当の失効 (抽出時点から約6時間)
// は最大で約1時間早い場合がある。その場合は再生タップ時のエラーで
// 取り消す (App.vue の error ハンドラ)。
export const AUDIO_URL_KEEP_MS = 6 * 60 * 60 * 1000;

export function localDbName(env) {
  return isStagingBuild(env) ? 'reader:db:v1:staging' : 'reader:db:v1';
}

/* ---- 純粋な計画関数 (IndexedDB に触れない) ---- */

// エントリの記事IDを先に解決する。ID 計算 (SHA-256) は非同期なので、
// IndexedDB トランザクションの中で行わず、外で済ませておくための分離。
// リンクの無いエントリは取り込まず、同じ記事の重複は1件にまとめる。
async function resolveEntryIds(entries, feedId) {
  const resolved = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    // オブジェクトでないエントリは取り込まない。文字列エントリは
    // String.prototype.link (関数) を link として拾ってしまい、
    // 幽霊記事を作るため、ここで型を見る。
    if (!entry || typeof entry !== 'object') continue;
    const key = entry.guid || entry.link;
    if (!key || !entry.link) continue;
    const id = await articleId(feedId, key);
    if (seen.has(id)) continue;
    seen.add(id);
    resolved.push({ id, entry });
  }
  return resolved;
}

// 既存レコードと新しいエントリから、音声まわりのフィールド
// (audio_url / audio_url_at / audio_stale / duration_sec) を決める。
// - 新鮮な enclosure が来た: URL と受け取り時刻を更新し、印を下ろす。
// - enclosure が来なかった: 既存URLが「最後に新鮮なURLを受け取った
//   時点」から6時間未満なら保持して印を立てる (ボタンは消さない)。
//   6時間以上なら消す (ボタンが消えるのはこの時点)。
// - 既存レコードに受け取り時刻が無い (この仕組みより前のデータ):
//   一度だけ猶予として受け取り時刻を今回に置き、印を立てて保持する。
// 長さ (duration_sec) は enclosure と一緒に来るものなので、保持する
// 場合は新しいエントリに無ければ前回分を保つ。
function resolveAudioFields(prev, entry, fetchedAtIso) {
  const freshUrl = String(entry.audioUrl || '');
  if (freshUrl) {
    return {
      audio_url: freshUrl,
      audio_url_at: fetchedAtIso,
      audio_stale: false,
      duration_sec: entry.durationSec ?? null,
    };
  }
  const prevUrl = prev.audio_url || '';
  if (!prevUrl) {
    return {
      audio_url: '',
      audio_url_at: '',
      audio_stale: false,
      duration_sec: entry.durationSec ?? null,
    };
  }
  const keptDuration = entry.durationSec ?? prev.duration_sec ?? null;
  const prevAtMs = Date.parse(prev.audio_url_at || '');
  if (!Number.isFinite(prevAtMs)) {
    return {
      audio_url: prevUrl,
      audio_url_at: fetchedAtIso,
      audio_stale: true,
      duration_sec: keptDuration,
    };
  }
  const fetchedAtMs = Date.parse(fetchedAtIso) || Date.now();
  if (fetchedAtMs - prevAtMs < AUDIO_URL_KEEP_MS) {
    return {
      audio_url: prevUrl,
      audio_url_at: prev.audio_url_at,
      audio_stale: true,
      duration_sec: keptDuration,
    };
  }
  return {
    audio_url: '',
    audio_url_at: '',
    audio_stale: false,
    duration_sec: entry.durationSec ?? null,
  };
}

// YouTube 由来のフィード (チャンネル／プレイリスト) かどうか。
// App.vue の youtubeFeedIds と同じ判定 (保存 URL からチャンネル ID か
// プレイリスト ID が取れるか) で、サーバー側の RSS 出し分けとも揃える。
function isYouTubeManagedFeed(feed) {
  const url = feed && typeof feed.url === 'string' ? feed.url : '';
  if (!url) return false;
  return !!(youtubeChannelIdFromUrl(url) || youtubePlaylistIdFromUrl(url));
}

// 過去分ガードの実効モード (純関数)。フィード設定 (pastGuard) が
// あればそれを使い、未指定なら種別既定に倒す: 通常フィードは
// 'skip' (取り込まない)、YouTube 由来は 'read' (既読として取り込む)。
// YouTube を 'read' にするのは、サーバー側で件数が絞られ (チャンネルは
// 直近20件)、プレイリストの古い曲も記事として残したい一方で、
// 既読にして掃除された古い動画が未読として戻ってくるのを防ぐため。
export function effectivePastGuard(feed) {
  const mode = normalizePastGuard(feed && feed.pastGuard);
  if (mode) return mode;
  return isYouTubeManagedFeed(feed) ? 'read' : 'skip';
}

// ローカル掃除の対象外かどうか (純関数)。フィード設定 (pruneExempt)
// だけで決める: 'on' のフィードだけ対象外で、未指定・'off' は対象。
// 種別による既定は持たない。YouTube のように最新分しか再配信されず
// 消すと戻らないフィードは、管理画面で 'on' を設定して守る (保持
// ルールは「消しても再配信で戻る」前提で組まれているため)。
export function effectivePruneExempt(feed) {
  return normalizePruneExempt(feed && feed.pruneExempt) === 'on';
}

// 過去分 (アーカイブ) のエントリかどうか。公開日時が、取り込み時点から
// 保持期間 (既読の掃除と同じ RETENTION_DAYS) より古ければ過去分。
// 公開日時が読めないエントリは過去分とみなさない (取りこぼし防止に倒す)。
export function isBackCatalogEntry(entry, fetchedAtIso, retentionDays = RETENTION_DAYS) {
  const published = parseTimeMs(entry ? entry.publishedAt : '');
  if (!published) return false;
  const fetched = parseTimeMs(fetchedAtIso) || Date.now();
  return fetched - published > retentionDays * 24 * 60 * 60 * 1000;
}

// ID 解決済みエントリから、IndexedDB へ put する記事レコードを組み立てる。
// 新規記事は未読。既存記事は既読状態 (is_read / read_at)・再生位置
// (play_pos) と取り込み日時 (fetched_at: 経過日数の起点) を保ち、
// メタデータだけ最新化する。existingById が新しいほど、この不変条件
// (既読を未読へ戻さない・再生位置を減らさない) が実際に守られる。
// 音声URLは resolveAudioFields の規則で保持・消去する。
// 過去分ガード (実効モードは effectivePastGuard): 端末にまだ無い
// 記事で公開が保持期間より古いものの扱いを決める。'skip' は新規
// レコードを作らない (全アーカイブを配信するフィードで、後から
// 届いた過去分や、掃除で消えた既読記事が未読として戻ってくるのを
// 防ぐ)。'read' は既読として作る (記事としては残り再生もできるが、
// 未読にはならない)。'off' はガードなし (未読として作る)。
// 既存レコードの更新はモードによらず従来どおり。
// 墓標 (tombstonesById) がある新規記事は、ガードの判定より優先して
// 既読として作る。掃除で消えた既読記事が、公開が保持期間より新しい
// ためにガードを通って未読で戻ってくるのを防ぐのが墓標の役割。
function buildUpsertRecords(existingById, resolved, feed, fetchedAtIso, tombstonesById) {
  const guard = effectivePastGuard(feed);
  const targets = guard === 'skip'
    ? resolved.filter(
        ({ id, entry }) => (existingById && existingById[id]) || !isBackCatalogEntry(entry, fetchedAtIso)
      )
    : resolved;
  return targets.map(({ id, entry }) => {
    const prev = existingById ? existingById[id] : null;
    if (prev) {
      return {
        ...prev,
        title: entry.title,
        link: entry.link,
        published_at: entry.publishedAt || prev.published_at || '',
        summary: entry.summary || '',
        content: entry.content || '',
        author: entry.author || '',
        ...resolveAudioFields(prev, entry, fetchedAtIso),
      };
    }
    const tomb = tombstonesById ? tombstonesById[id] : null;
    const asRead = !!tomb || (guard === 'read' && isBackCatalogEntry(entry, fetchedAtIso));
    return {
      id,
      feed_id: feed.id,
      title: entry.title,
      link: entry.link,
      published_at: entry.publishedAt || '',
      fetched_at: fetchedAtIso,
      summary: entry.summary || '',
      content: entry.content || '',
      author: entry.author || '',
      audio_url: entry.audioUrl || '',
      audio_url_at: entry.audioUrl ? fetchedAtIso : '',
      audio_stale: false,
      duration_sec: entry.durationSec ?? null,
      play_pos: 0,
      is_read: asRead,
      read_at: asRead ? ((tomb && tomb.read_at) || fetchedAtIso) : '',
      // スターはサーバーが正本。取り込みでは作らず・消さず、
      // list 応答からの同期 (syncLocalArticleStars) と付け外し
      // (setLocalArticleStar) だけで変わる。既存レコードは
      // 上の ...prev でそのまま保たれる。
      starred: false,
      star_state: '',
    };
  });
}

// 取得エントリから、IndexedDB へ put する記事レコードを組み立てる。
export async function planUpserts(existingById, entries, feed, fetchedAtIso, tombstonesById) {
  const resolved = await resolveEntryIds(entries, feed.id);
  return buildUpsertRecords(existingById, resolved, feed, fetchedAtIso, tombstonesById);
}

// ローカルの保持ルール: 既読記事は「取り込んでから60日」を過ぎたら消す。
// 合計が上限を超える場合は、新しい順に残して古い既読から消す。
// 未読は日数でも件数でも消さない (サーバー側 prunePlan と同じ考え方)。
// exemptFeedIds に挙がったフィードの記事は、日数でも件数でも消さない。
// YouTube のように配信側が最新分しか再配信しないフィードでは、消した
// 記事は二度と戻らない (「消しても再配信で戻る」前提が成り立たない)
// ため、呼び出し側がそれらのフィードを対象外として渡す。
export function planLocalPrune(articles, nowIso, { retentionDays = RETENTION_DAYS, maxArticles = MAX_ARTICLES, exemptFeedIds = null } = {}) {
  const now = nowIso ? Date.parse(nowIso) : Date.now();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  // レコードでない要素は計画の対象にしない (ID が無く、消しようがない)。
  const list = (Array.isArray(articles) ? articles : []).filter((a) => a && typeof a === 'object');
  const sorted = list.slice().sort((a, b) => articleTime(b) - articleTime(a));
  const keepRank = {};
  sorted.forEach((a, idx) => { keepRank[a.id] = idx < maxArticles; });
  const ids = [];
  list.forEach((a) => {
    if (!a.is_read) return;
    if (exemptFeedIds && exemptFeedIds.has(a.feed_id)) return;
    const t = parseTimeMs(a.fetched_at || a.published_at);
    const tooOld = t > 0 && now - t > retentionMs;
    if (tooOld || !keepRank[a.id]) ids.push(a.id);
  });
  return ids;
}

// 掃除で消す既読記事の墓標を作る。記事本体は消しても、ID・フィード・
// 既読日時のだけを残し、同じ記事が再配信されてきたときに既読で
// 戻せるようにする。未読記事は対象にしない (planLocalPrune の結果は
// 既読だけだが、単独で呼ばれても安全なようにここでも見る)。
export function planTombstones(articles, prunedAtIso) {
  const list = (Array.isArray(articles) ? articles : [])
    .filter((a) => a && typeof a === 'object' && a.id && a.is_read);
  const seen = new Set();
  const out = [];
  list.forEach((a) => {
    if (seen.has(a.id)) return;
    seen.add(a.id);
    out.push({
      id: a.id,
      feed_id: a.feed_id || '',
      read_at: a.read_at || prunedAtIso,
      pruned_at: prunedAtIso,
    });
  });
  return out;
}

// 墓標の掃除。保持期間を過ぎたものと、上限を超えた古いものから消す。
export function planTombstonePrune(tombstones, nowIso, { retentionDays = TOMBSTONE_RETENTION_DAYS, maxTombstones = MAX_TOMBSTONES } = {}) {
  const now = nowIso ? Date.parse(nowIso) : Date.now();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const list = (Array.isArray(tombstones) ? tombstones : [])
    .filter((t) => t && typeof t === 'object' && t.id);
  const sorted = list.slice().sort((a, b) => parseTimeMs(b.pruned_at) - parseTimeMs(a.pruned_at));
  const keepRank = {};
  sorted.forEach((t, idx) => { keepRank[t.id] = idx < maxTombstones; });
  const ids = [];
  list.forEach((t) => {
    const at = parseTimeMs(t.pruned_at);
    const tooOld = at > 0 && now - at > retentionMs;
    if (tooOld || !keepRank[t.id]) ids.push(t.id);
  });
  return ids;
}

// 日時の読み方。文字列だけを解釈し、それ以外は 0 として読む。
// Date.parse の素通しは、文字列化できない値で投げるため。
function parseTimeMs(v) {
  return typeof v === 'string' ? Date.parse(v) || 0 : 0;
}

function articleTime(a) {
  return parseTimeMs(a.published_at || a.fetched_at);
}

// 削除同期の上限 (1回の取り込みで消す記事数)。プレイリストの
// サーバー側同期と同じ考え方で、取得側の異常 (フィードが別物に
// 化けた等) で大量に消してしまわないための歯止め。超えたら今回の
// 同期だけを見送る (blocked: true)。
export const SYNC_DELETES_MAX_PER_RUN = 100;

// 削除同期の計画 (純関数): そのフィードの既存記事のうち、今回の
// 取得集合 (presentIds) に無いものを消す対象にする。取得集合が
// 空のときは同期しない (空 = 取得異常と区別できないため)。
// 削除候補が上限を超えたら blocked にして何も消さない。
export function planSyncDeletions(articles, feedId, presentIds, { maxDeletions = SYNC_DELETES_MAX_PER_RUN } = {}) {
  const present = new Set(presentIds || []);
  if (!feedId || present.size === 0) return { deleteIds: [], blocked: false, candidates: 0 };
  const deleteIds = [];
  (Array.isArray(articles) ? articles : []).forEach((a) => {
    if (!a || typeof a !== 'object' || !a.id) return;
    if (String(a.feed_id || '') !== String(feedId)) return;
    if (!present.has(a.id)) deleteIds.push(a.id);
  });
  if (deleteIds.length > maxDeletions) {
    return { deleteIds: [], blocked: true, candidates: deleteIds.length };
  }
  return { deleteIds, blocked: false, candidates: deleteIds.length };
}

// フィード一覧から消えたフィードの記事 (残しておくと行き場のない記事になる)。
export function planOrphanArticles(articles, feedIds) {
  const live = new Set(feedIds || []);
  return (Array.isArray(articles) ? articles : [])
    .filter((a) => a && typeof a === 'object' && !live.has(a.feed_id))
    .map((a) => a.id);
}

/* ---- フィードIDのハッシュ化に伴う移行 ---- */

// 移行済みフラグと、付け替え待ちの状態の置き場 (meta ストアのキー)。
export const FEED_HASH_MIGRATED_KEY = 'feedHashMigratedV3';
export const FEED_HASH_TRANSFER_KEY = 'feedHashTransferV3';

// 付け替え状態のキー: 新フィードID＋リンク。記事レコードには guid が
// 残っていないため、付け替えは (フィード, リンク) で対応付ける。
export function transferKey(feedId, link) {
  return `${feedId}\n${link}`;
}

// 付け替えで退避する記事の状態 (既読・再生位置・取り込み日時)。
function stagedStateOf(record) {
  return {
    is_read: !!record.is_read,
    read_at: record.read_at || '',
    play_pos: record.play_pos || 0,
    fetched_at: record.fetched_at || '',
  };
}

// 記事レコードを旧フィードIDから新フィードID (idMap: 旧ID -> 新ID) へ
// 付け替える計画を立てる共通形。新しい記事 ID をその場で計算できる
// レコード (newArticleId が ID を返すもの) は、状態 (既読・再生位置・
// 音声情報) を保ったまま ID を計算し直してそのまま付け替え (puts)、
// 計算できないものは状態だけを staged に退避し、再取得時の取り込みで
// (フィード, リンク) が一致した記事へ戻す。旧レコードはどちらも消す。
async function planArticleRekey(records, idMap, newArticleId) {
  const puts = [];
  const deletes = [];
  const staged = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object') continue;
    const newId = idMap ? idMap[record.feed_id] : '';
    if (!newId || newId === record.feed_id) continue;
    deletes.push(record.id);
    const id = await newArticleId(record, newId);
    if (id) {
      puts.push({ ...record, id, feed_id: newId });
    } else {
      staged.push({ feedId: newId, link: record.link, state: stagedStateOf(record) });
    }
  }
  return { puts, deletes, staged };
}

// フィードIDのハッシュ化に伴う付け替え。記事IDが「旧ID＋リンク」から
// 再現できるレコード (guid がリンクと同一だったもの) はそのまま
// 付け替え、再現できないもの (YouTube のように guid ≠ リンク) は
// 状態だけを staged へ退避する。
export async function planFeedRekey(records, idMap) {
  return planArticleRekey(records, idMap, async (record, newId) => {
    const fromLink = await articleId(record.feed_id, record.link);
    return fromLink === record.id ? articleId(newId, record.link) : null;
  });
}

// staged な付け替え状態を meta のマップへ合体させる (同じキーは上書き)。
export function mergeTransferredState(map, staged) {
  const out = { ...(map || {}) };
  (Array.isArray(staged) ? staged : []).forEach((s) => {
    if (!s || typeof s !== 'object' || typeof s.feedId !== 'string' || typeof s.link !== 'string') return;
    out[transferKey(s.feedId, s.link)] = s.state;
  });
  return out;
}

// 取り込み直後のレコードへ、付け替え状態を戻す。既にローカルにある
// レコード (existingById に居るもの) には触らない。戻せたキーは
// consumedKeys に返し、呼び出し側がマップから消す。
export function applyTransferredState(records, transfer, feedId, existingById) {
  if (!transfer) return { records, consumedKeys: [] };
  const consumedKeys = [];
  const out = (Array.isArray(records) ? records : []).map((record) => {
    if (!record || typeof record !== 'object' || typeof record.link !== 'string') return record;
    if (existingById && existingById[record.id]) return record;
    const key = transferKey(feedId, record.link);
    const state = transfer[key];
    if (!state) return record;
    consumedKeys.push(key);
    return {
      ...record,
      is_read: !!state.is_read,
      read_at: state.read_at || '',
      play_pos: state.play_pos || 0,
      fetched_at: state.fetched_at || record.fetched_at,
    };
  });
  return { records: out, consumedKeys };
}

// 付け替えマップの掃除: keepFeedIds に残すフィード分だけを返す。
// 取得に成功したフィードは付け替えの機会を終えた (一致しなかった
// 記事はフィードから外れた) ので落とし、失敗したフィード分は
// 次回の取得で戻せるよう残す。
export function pruneTransferredState(transfer, keepFeedIds) {
  const keep = keepFeedIds instanceof Set ? keepFeedIds : new Set(keepFeedIds || []);
  const out = {};
  Object.entries(transfer || {}).forEach(([key, value]) => {
    const feedId = key.split('\n')[0];
    if (keep.has(feedId)) out[key] = value;
  });
  return out;
}

// DB レコードを表示用 (listState が扱う camelCase 形) へ変換する。
// 音声URLは、最後に新鮮な enclosure を受け取ってから6時間以上経って
// いれば、次回の背景更新を待たずにここで音声なしとして扱う
// (ボタンが出ない)。6時間未満で印 (audio_stale) が立っているものは、
// URL を保持したまま audioStale として出す。
export function articleRecordToView(record, feedTitle, nowMs = Date.now()) {
  const rawUrl = record.audio_url || '';
  const atMs = Date.parse(record.audio_url_at || '');
  let audioUrl = rawUrl;
  let audioStale = false;
  if (rawUrl) {
    if (Number.isFinite(atMs) && nowMs - atMs >= AUDIO_URL_KEEP_MS) {
      audioUrl = '';
    } else {
      audioStale = !!record.audio_stale;
    }
  }
  return {
    id: record.id,
    feedId: record.feed_id,
    feedTitle: feedTitle || '',
    title: record.title,
    link: record.link,
    publishedAt: record.published_at || '',
    fetchedAt: record.fetched_at || '',
    summary: record.summary || '',
    content: record.content || '',
    author: record.author || '',
    audioUrl,
    audioUrlAt: audioUrl ? (record.audio_url_at || '') : '',
    audioStale: audioUrl ? audioStale : false,
    durationSec: record.duration_sec ?? null,
    playPos: record.play_pos || 0,
    isRead: !!record.is_read,
    starred: !!record.starred,
    starState: record.star_state || '',
  };
}

/* ---- IndexedDB の薄いラッパー ---- */

let dbPromise = null;
let openDb = null;

export function openLocalDb(env) {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(localDbName(env), 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('articles')) {
          const articles = db.createObjectStore('articles', { keyPath: 'id' });
          articles.createIndex('feed_id', 'feed_id', { unique: false });
          articles.createIndex('published_at', 'published_at', { unique: false });
        }
        if (!db.objectStoreNames.contains('feeds')) {
          db.createObjectStore('feeds', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('tombstones')) {
          const tombstones = db.createObjectStore('tombstones', { keyPath: 'id' });
          tombstones.createIndex('feed_id', 'feed_id', { unique: false });
        }
      };
      req.onsuccess = () => {
        openDb = req.result;
        // 他のページが版を上げようとしたら、塞がずに接続を手放す。
        openDb.onversionchange = () => closeLocalDb();
        resolve(openDb);
      };
      req.onerror = () => reject(req.error || new Error('indexeddb_open_failed'));
    });
  }
  return dbPromise;
}

// 開いている接続を閉じて、次回は開き直すようにする。ページが
// 破棄・凍結 (bfcache) される前に呼ぶためのもの: 接続を開いた
// まま凍結されると、次に開いたページの読み込みがその接続と
// 競合して固まることがある。
export function closeLocalDb() {
  if (openDb) {
    try { openDb.close(); } catch { /* 既に閉じている */ }
    openDb = null;
  }
  dbPromise = null;
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

export function loadLocalTombstones() {
  return getAll('tombstones');
}

export function putLocalTombstones(records) {
  return putAll('tombstones', records);
}

export function deleteLocalTombstones(ids) {
  return deleteByIds('tombstones', ids);
}

// 1フィード分の取り込みを、単一の readwrite トランザクションで完結させる。
// そのフィードの既存レコードの読み直し → レコード構築 → 付け替え状態の
// 適用 → 書き込みを同じ tx で行う。IndexedDB の tx は直列化されるため、
// この tx より前にコミットされた既読化・再生位置は読み直しに見え、後に
// 来た既読化は取り込み済みレコードに対して効く。どちらの順序でも、
// 取り込み開始時点の古いスナップショットで状態が巻き戻ることはない。
// transfer は付け替え状態のマップ (無ければ null)。戻り値の consumedKeys
// は取り込みで消費できたキーで、マップからの削除は呼び出し側が行う。
export async function ingestFeedArticles(feed, entries, fetchedAtIso, transfer, options) {
  const resolved = await resolveEntryIds(entries, feed.id);
  const db = await openLocalDb();
  const tx = db.transaction(['articles', 'tombstones'], 'readwrite');
  const store = tx.objectStore('articles');
  const tombStore = tx.objectStore('tombstones');
  const existing = await requestToPromise(store.index('feed_id').getAll(feed.id));
  const existingById = {};
  existing.forEach((r) => { existingById[r.id] = r; });
  // 墓標 (掃除で消した既読記事の記録) は同じ tx で読み、新規レコードの
  // 既読判定に使う。既読として戻せた墓標はここで消費する: 残しておくと、
  // その記事を未読に戻してから消えたときに既読で復活してしまう。
  const tombs = await requestToPromise(tombStore.index('feed_id').getAll(feed.id));
  const tombstonesById = {};
  tombs.forEach((t) => { tombstonesById[t.id] = t; });
  let records = buildUpsertRecords(existingById, resolved, feed, fetchedAtIso, tombstonesById);
  records.forEach((r) => {
    if (!existingById[r.id] && tombstonesById[r.id]) tombStore.delete(r.id);
  });
  let consumedKeys = [];
  if (transfer) {
    const applied = applyTransferredState(records, transfer, feed.id, existingById);
    records = applied.records;
    consumedKeys = applied.consumedKeys;
  }
  records.forEach((r) => store.put(r));
  // 削除同期: フィード設定 (syncDeletes) がオンで、文書を最後まで
  // 受信できた (options.feedComplete) ときだけ、取得集合に無い既存
  // 記事を同じトランザクションで消す。YouTube 由来はサーバー管理
  // (プレイリストはサーバー側で同期済み) のため対象にしない。
  let syncDeletedIds = [];
  if (
    feed && feed.syncDeletes === true && !isYouTubeManagedFeed(feed)
    && options && options.feedComplete === true
  ) {
    const plan = planSyncDeletions(existing, feed.id, resolved.map(({ id }) => id));
    if (!plan.blocked) {
      plan.deleteIds.forEach((id) => store.delete(id));
      syncDeletedIds = plan.deleteIds;
    }
  }
  await txDone(tx);
  return { records, consumedKeys, syncDeletedIds };
}

// 記事レコード1件を読み、mutate を適用して書き戻す共通処理。
// 対象が無ければ何もしない。
async function updateArticleRecord(id, mutate) {
  const db = await openLocalDb();
  const tx = db.transaction('articles', 'readwrite');
  const store = tx.objectStore('articles');
  const record = await requestToPromise(store.get(id));
  if (record) {
    mutate(record);
    store.put(record);
  }
  await txDone(tx);
}

// 記事1件の既読を切り替える。
export function setLocalArticleRead(id, isRead, readAtIso) {
  return updateArticleRecord(id, (record) => {
    record.is_read = !!isRead;
    record.read_at = isRead ? (readAtIso || '') : '';
  });
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

// 記事1件のスター (実効スターと手動オーバーライド) を切り替える。
export function setLocalArticleStar(id, starred, starState) {
  return updateArticleRecord(id, (record) => {
    record.starred = !!starred;
    record.star_state = starState || '';
  });
}

// サーバーの list 応答に含まれるスター状態で、ローカルレコードを
// 一括で上書きする。rows はサーバー形 ({id, starred, star_state})。
// ローカルに無い記事は作らない (記事の取り込みはフィード取得側の
// 仕事)。値が変わるレコードだけを書き戻す。
export async function syncLocalArticleStars(rows) {
  const wanted = new Map();
  (rows || []).forEach((row) => {
    if (row && row.id) wanted.set(row.id, row);
  });
  if (!wanted.size) return;
  const db = await openLocalDb();
  const tx = db.transaction('articles', 'readwrite');
  const store = tx.objectStore('articles');
  for (const [id, row] of wanted) {
    const record = await requestToPromise(store.get(id));
    if (!record) continue;
    const starred = !!row.starred;
    const starState = row.star_state || '';
    if (record.starred === starred && (record.star_state || '') === starState) continue;
    record.starred = starred;
    record.star_state = starState;
    store.put(record);
  }
  await txDone(tx);
}

// 再生位置 (秒) を保存する。
// レコードはオブジェクトごと保存する形なので、フィールド追加に
// DB のバージョン変更は要らない (索引は変えていない)。
export function setLocalArticlePlayPos(id, posSec) {
  return updateArticleRecord(id, (record) => {
    record.play_pos = Number.isFinite(posSec) && posSec > 0 ? Math.floor(posSec) : 0;
  });
}

// 再生位置を消す (再生し終えたエピソード用)。
export function clearLocalArticlePlayPos(id) {
  return setLocalArticlePlayPos(id, 0);
}

// 音声URLを取り消す。保持していた古いURLで再生を試みて即エラーに
// なった (失効していた) ときに使い、ボタンが消える状態にする。
export function clearLocalArticleAudio(id) {
  return updateArticleRecord(id, (record) => {
    record.audio_url = '';
    record.audio_url_at = '';
    record.audio_stale = false;
  });
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

// 付け替え計画 (状態の退避・付け替え・旧レコードの削除) を DB へ適用する。
async function applyRekeyPlan(plan) {
  if (plan.staged.length) {
    const current = await getLocalMeta(FEED_HASH_TRANSFER_KEY);
    await setLocalMeta(FEED_HASH_TRANSFER_KEY, mergeTransferredState(current, plan.staged));
  }
  if (plan.puts.length) await putLocalArticles(plan.puts);
  if (plan.deletes.length) await deleteLocalArticles(plan.deletes);
}

// フィードIDのハッシュ化の移行 (新ビルドの初回だけ)。キャッシュ済みの
// フィード一覧 (旧ID＋URL) から旧ID→新IDの対応を作り、記事を付け替える。
// フィード一覧のキャッシュが新しい一覧で上書きされる前に呼ぶこと。
// フラグで守られているので、途中で落ちても次回に安全にやり直せる
// (付け替え済みレコードは対応表の対象から外れ、二度付け替えしない)。
export async function migrateFeedHashIds() {
  if (await getLocalMeta(FEED_HASH_MIGRATED_KEY)) return { migrated: false };
  const cached = await loadLocalFeeds();
  const idMap = {};
  for (const feed of cached) {
    if (!feed?.id || !feed?.url) continue;
    const newId = await feedIdFromUrl(feed.url);
    if (newId && newId !== feed.id) idMap[feed.id] = newId;
  }
  const plan = await planFeedRekey(await loadLocalArticles(), idMap);
  await applyRekeyPlan(plan);
  await setLocalMeta(FEED_HASH_MIGRATED_KEY, true);
  return { migrated: true, rekeyed: plan.puts.length, staged: plan.staged.length };
}

/* ---- YouTube 保存 URL の形式変更 (videos.xml → /channel/) に伴う移行 ---- */

// 移行済みフラグ (meta ストアのキー)。退避状態の置き場は V3 と同じ
// FEED_HASH_TRANSFER_KEY を使う (取り込み時の復元は既存の仕組みが担う)。
export const YT_CHANNEL_URL_MIGRATED_KEY = 'ytChannelUrlMigratedV4';

// キャッシュ済みフィード (旧形式) とサーバーの新鮮なフィード一覧
// (新形式) を、チャンネル ID で対応付ける計画を立てる。
// 対応付けは「キャッシュ側が videos.xml 形式」かつ「サーバー側に
// 同じチャンネルの /channel/ 形式がある」場合だけ成立する。
// complete は「キャッシュ側の旧形式フィードがすべて処理可能」なこと:
// サーバー側がまだ旧形式のままのチャンネルが残っている間は false で、
// その間は完了フラグを立てず、次回の更新で付け替えを試し直す。
// サーバー一覧からチャンネル自体が消えたフィードは移行対象外
// (残った記事は孤児掃除が落とす) として complete を妨げない。
export function planYouTubeChannelPairs(cachedFeeds, serverFeeds) {
  const channelFormByChannel = new Map();
  const serverChannels = new Set();
  for (const feed of serverFeeds || []) {
    const channelId = youtubeChannelIdFromUrl(feed?.url);
    if (!channelId) continue;
    serverChannels.add(channelId);
    if (!isYouTubeFeedUrl(feed.url)) channelFormByChannel.set(channelId, feed);
  }
  const idMap = {};
  let blocked = false;
  for (const feed of cachedFeeds || []) {
    if (!feed?.id || !isYouTubeFeedUrl(feed?.url)) continue;
    const channelId = youtubeChannelIdFromUrl(feed.url);
    if (!channelId) continue;
    const target = channelFormByChannel.get(channelId);
    if (target) {
      if (target.id && target.id !== feed.id) idMap[feed.id] = target.id;
    } else if (serverChannels.has(channelId)) {
      blocked = true;
    }
  }
  return { idMap, complete: !blocked };
}

// YouTube 記事レコードを旧フィードIDから新フィードIDへ付け替える計画。
// 記事 ID は (新フィードID + 動画ID) で計算し直せるため、リンクから
// 動画 ID が取れるレコードはそのまま付け替え、取れないレコードは
// planFeedRekey と同様に状態だけを staged へ退避する。
export async function planYouTubeArticleRekey(records, idMap) {
  return planArticleRekey(records, idMap, async (record, newId) => {
    const videoId = youtubeVideoIdFromLink(record.link);
    return videoId ? articleId(newId, videoId) : null;
  });
}

// YouTube の保存 URL 形式変更に伴う移行。サーバー側のシート移行が
// 済むまではサーバーが旧形式を返し続けるため、完了条件 (計画の
// complete) を満たすまではフラグを立てず、更新のたびに試し直す。
// キャッシュが新しい一覧で上書きされる前に呼ぶこと (付け替えの素材は
// キャッシュ済みの旧形式一覧のため)。付け替え済みレコードは対応表の
// 対象から外れるので、途中で落ちても二重に付け替えたりはしない。
export async function migrateYouTubeChannelUrlIds(serverFeeds) {
  if (await getLocalMeta(YT_CHANNEL_URL_MIGRATED_KEY)) return { migrated: false };
  const cached = await loadLocalFeeds();
  const { idMap, complete } = planYouTubeChannelPairs(cached, serverFeeds);
  const plan = await planYouTubeArticleRekey(await loadLocalArticles(), idMap);
  await applyRekeyPlan(plan);
  if (complete) await setLocalMeta(YT_CHANNEL_URL_MIGRATED_KEY, true);
  return { migrated: true, complete, rekeyed: plan.puts.length, staged: plan.staged.length };
}
