// 未変更フィードの取り込み省略と、音声URLの6時間ルールの相互作用
// (App.vue + localDb) のコンポーネントテスト。
// 固定したい振る舞い:
// - 取得した XML が前回と同じ (unchanged) で取り込みを省いても、
//   音声URLの受け取り時刻は進み、表示側の6時間ルールで再生ボタン
//   が消えない (PR #155 の回帰: 省いたままだと、XML が変わらない
//   フィードのボタンが6時間後に全部消えた)。
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, nextTick } from 'vue';

// https://feeds.rebuild.fm/rebuildfm のハッシュID (feedHash で固定済み)。
const FEED_ID = 'b81e59da11f890d2';
const FEED = {
  id: FEED_ID,
  title: 'Rebuild',
  url: 'https://feeds.rebuild.fm/rebuildfm',
  category: 'ポッドキャスト',
  enabled: true,
  lastStatus: '200',
  lastError: '',
  lastFetchedAt: '',
  unreadCount: 1,
};

vi.mock('../src/lib/api.js', () => ({
  setStar: vi.fn(async () => ({ ok: true })),
  deleteFeed: vi.fn(async () => ({ ok: true })),
  exchangeSession: vi.fn(async () => ({ ok: true })),
  exchangeShare: vi.fn(async () => ({ ok: true })),
  listArticles: vi.fn(async () => ({ ok: true, feeds: [FEED], articles: [] })),
  listFeeds: vi.fn(async () => ({ ok: true, feeds: [FEED] })),
  getShareLinkStatus: vi.fn(async () => ({ ok: true, active: false, expiresAt: null })),
  getFeedStats: vi.fn(async () => ({ ok: true, stats: {} })),
  issueShareLink: vi.fn(async () => ({ ok: true, token: 'dummy-share-token', expiresAt: '2026-12-16T05:47:00.000Z' })),
  revokeShareLink: vi.fn(async () => ({ ok: true })),
  logEvents: vi.fn(async () => ({ ok: true, saved: 0 })),
  reorderFeeds: vi.fn(async () => ({ ok: true })),
  saveFeed: vi.fn(async () => ({ ok: true, feed: FEED })),
}));

// 取得は毎回「前回と同じ XML」を返し、取り込みが省かれる状況にする。
vi.mock('../src/lib/feedFetch.js', () => ({
  fetchAllFeeds: vi.fn(async (feeds) => (feeds || []).map((feed) => ({
    feed, ok: true, unchanged: true, entries: [], complete: true, contentHash: 'same', error: null,
  }))),
  fetchFeedXml: vi.fn(async () => ''),
  fetchOneFeed: vi.fn(async (feed) => ({ feed, ok: false, entries: [], error: new Error('not mocked') })),
}));

vi.mock('../src/config.js', () => ({
  API_URL: 'https://example.com/exec',
  GOOGLE_CLIENT_ID: 'test-client-id',
}));

import App from '../src/App.vue';
import { loadLocalArticles, saveLocalFeeds, putLocalArticles, deleteLocalArticles } from '../src/lib/localDb.js';

class FakeAudio extends EventTarget {
  constructor() {
    super();
    this.src = '';
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = Number.NaN;
    this.playbackRate = 1;
    this.preload = '';
  }

  play() {
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }

  load() {}

  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }
}

let app = null;
let el = null;
let errors = [];

async function flushUntil(cond, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('flushUntil: 条件が満たされませんでした');
  }
}

beforeEach(() => {
  errors = [];
  document.body.innerHTML = '';
  localStorage.clear();
  localStorage.setItem(
    'reader:session:v1',
    JSON.stringify({ token: 'tok', role: 'owner', expiresAt: null })
  );
  vi.stubGlobal('Audio', FakeAudio);
  vi.clearAllMocks();
});

afterEach(() => {
  if (app) app.unmount();
  app = null;
  if (el) el.remove();
  el = null;
});

describe('未変更フィードでも音声URLの時刻が進む', () => {
  it('受け取りから6時間超の記事でも、更新後に再生ボタンが出る', async () => {
    const staleAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const existing = await loadLocalArticles();
    if (existing.length) await deleteLocalArticles(existing.map((a) => a.id));
    await saveLocalFeeds([FEED]);
    await putLocalArticles([{
      id: 'ep-stale',
      feed_id: FEED_ID,
      title: '古いエピソード',
      link: 'https://example.com/ep-stale',
      published_at: '2026-11-14T00:00:00.000Z',
      fetched_at: '2026-11-15T00:00:00.000Z',
      summary: '',
      author: '',
      audio_url: 'https://example.com/ep-stale.mp3',
      audio_url_at: staleAt,
      audio_stale: false,
      duration_sec: 1800,
      play_pos: 0,
      is_read: false,
      read_at: '',
    }]);

    el = document.createElement('div');
    document.body.appendChild(el);
    app = createApp(App);
    app.config.errorHandler = (err) => { errors.push(err); };
    app.mount(el);

    // カードは出るが、当初は6時間ルールで再生ボタンが無い。
    await flushUntil(() => el.querySelectorAll('.article-card').length === 1);
    expect(el.querySelector('.article-card .play-btn')).toBeNull();

    // 背景更新 (unchanged で取り込み省略) が済むと、ボタンが出る。
    await flushUntil(() => !!el.querySelector('.article-card .play-btn'));
    const row = (await loadLocalArticles()).find((a) => a.id === 'ep-stale');
    expect(row.audio_url_at).not.toBe(staleAt);
    expect(Date.now() - Date.parse(row.audio_url_at)).toBeLessThan(60 * 1000);
    expect(errors).toEqual([]);
    await deleteLocalArticles(['ep-stale']);
  });
});
