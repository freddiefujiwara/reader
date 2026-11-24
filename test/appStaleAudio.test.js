// stale な音声URL (印つきエピソード) のコンポーネントテスト。
// 固定したい振る舞い:
// - 保持中のエピソードには印 (ドットと aria-label) が出る。
// - タップするとそのフィードだけを取り直し、新鮮な enclosure が
//   来ればそのURLで、来なければ保持URLで再生する。
// - 保持URLでの再生が即エラーになったら、音声を取り消して
//   ボタンが消え、プレイヤーも閉じる。
// - 表示時点で6時間を超えたURLはボタン自体が出ない。
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

const GUID = 'vid-stale-1';
const KEPT_URL = 'https://example.com/kept.mp3';
const FRESH_URL = 'https://example.com/fresh.mp3';
const hoursAgoIso = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

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

vi.mock('../src/lib/feedFetch.js', () => ({
  fetchAllFeeds: vi.fn(async () => []),
  fetchFeedXml: vi.fn(async () => ''),
  fetchOneFeed: vi.fn(async (feed) => ({ feed, ok: false, entries: [], error: new Error('not mocked') })),
}));

vi.mock('../src/config.js', () => ({
  API_URL: 'https://example.com/exec',
  GOOGLE_CLIENT_ID: 'test-client-id',
}));

import App from '../src/App.vue';
import { fetchOneFeed } from '../src/lib/feedFetch.js';
import { articleId } from '../src/lib/articleId.js';
import { loadLocalArticles, saveLocalFeeds, putLocalArticles } from '../src/lib/localDb.js';

const audioInstances = [];
class FakeAudio extends EventTarget {
  constructor() {
    super();
    audioInstances.push(this);
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
    this.ended = false;
    this.dispatchEvent(new window.Event('play'));
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.dispatchEvent(new window.Event('pause'));
  }

  load() {}

  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }
}

let app = null;
let el = null;
let errors = [];
let staleId = null;

const latestAudio = () => audioInstances[audioInstances.length - 1];

async function flushUntil(cond, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('flushUntil: 条件が満たされませんでした');
  }
}

async function seedStale(atIso) {
  staleId = await articleId(FEED_ID, GUID);
  await saveLocalFeeds([FEED]);
  await putLocalArticles([{
    id: staleId,
    feed_id: FEED_ID,
    title: '古いエピソード',
    link: 'https://example.com/vid-stale-1',
    published_at: '2026-11-15T00:00:00.000Z',
    fetched_at: '2026-11-15T00:00:00.000Z',
    summary: '',
    author: '',
    audio_url: KEPT_URL,
    audio_url_at: atIso,
    audio_stale: true,
    duration_sec: 1800,
    play_pos: 0,
    is_read: false,
    read_at: '',
  }]);
}

async function mountApp() {
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
  await flushUntil(() => el.querySelectorAll('.article-card').length === 1);
}

const entry = (extra = {}) => ({
  guid: GUID,
  title: '古いエピソード',
  link: 'https://example.com/vid-stale-1',
  publishedAt: '2026-11-15T00:00:00.000Z',
  summary: '',
  author: '',
  ...extra,
});

beforeEach(() => {
  errors = [];
  audioInstances.length = 0;
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
  el = null;
  vi.unstubAllGlobals();
});

describe('stale なエピソードの表示', () => {
  it('保持中のボタンには印が出て、aria-label に古い旨が入る', async () => {
    await seedStale(hoursAgoIso(1));
    await mountApp();
    const btn = el.querySelector('.play-btn');
    expect(btn, '再生ボタンが出る').toBeTruthy();
    expect(btn.querySelector('.play-btn-badge'), '印のドットが出る').toBeTruthy();
    expect(btn.getAttribute('aria-label')).toContain('古くなっています');
    expect(errors).toEqual([]);
  });

  it('表示時点で6時間を超えたURLはボタン自体が出ない', async () => {
    await seedStale(hoursAgoIso(7));
    await mountApp();
    expect(el.querySelector('.play-btn')).toBeNull();
    expect(errors).toEqual([]);
  });
});

describe('stale なエピソードのタップ時の再取得', () => {
  it('新鮮な enclosure が来たら、そのURLで再生し、印が消える', async () => {
    await seedStale(hoursAgoIso(1));
    fetchOneFeed.mockResolvedValue({
      feed: FEED, ok: true, error: null,
      entries: [entry({ audioUrl: FRESH_URL, durationSec: 1800 })],
    });
    await mountApp();
    el.querySelector('.play-btn').click();
    await flushUntil(() => latestAudio() && latestAudio().src === FRESH_URL);
    expect(fetchOneFeed).toHaveBeenCalledTimes(1);
    expect(fetchOneFeed.mock.calls[0][0].id).toBe(FEED_ID);
    expect(el.querySelector('.player-title').textContent).toBe('古いエピソード');
    // 取り直しで印は下り、保持時刻も更新されている。
    await flushUntil(() => !el.querySelector('.play-btn-badge'));
    const row = (await loadLocalArticles()).find((a) => a.id === staleId);
    expect(row.audio_url).toBe(FRESH_URL);
    expect(row.audio_stale).toBe(false);
    expect(errors).toEqual([]);
  });

  it('新鮮な enclosure が来なければ、保持URLで再生し、プレイヤーにも印が出る', async () => {
    await seedStale(hoursAgoIso(1));
    fetchOneFeed.mockResolvedValue({
      feed: FEED, ok: true, error: null,
      entries: [entry({})],
    });
    await mountApp();
    el.querySelector('.play-btn').click();
    await flushUntil(() => latestAudio() && latestAudio().src === KEPT_URL);
    expect(el.querySelector('.player-stale'), 'プレイヤーに印が出る').toBeTruthy();
    expect(el.querySelector('.player-stale').textContent).toContain('古い音声URL');
    expect(errors).toEqual([]);
  });

  it('取り直し自体が失敗しても、保持URLで再生を試みる', async () => {
    await seedStale(hoursAgoIso(1));
    fetchOneFeed.mockResolvedValue({ feed: FEED, ok: false, entries: [], error: new Error('network') });
    await mountApp();
    el.querySelector('.play-btn').click();
    await flushUntil(() => latestAudio() && latestAudio().src === KEPT_URL);
    expect(errors).toEqual([]);
  });

  it('保持URLの再生が即エラーになったら、音声を取り消してボタンが消え、プレイヤーが閉じる', async () => {
    await seedStale(hoursAgoIso(1));
    fetchOneFeed.mockResolvedValue({ feed: FEED, ok: false, entries: [], error: new Error('network') });
    await mountApp();
    el.querySelector('.play-btn').click();
    await flushUntil(() => latestAudio() && latestAudio().src === KEPT_URL);
    expect(el.querySelector('.player-bar'), 'プレイヤーが出ている').toBeTruthy();

    latestAudio().dispatchEvent(new window.Event('error'));
    await flushUntil(() => !el.querySelector('.player-bar') && !el.querySelector('.play-btn'));
    const row = (await loadLocalArticles()).find((a) => a.id === staleId);
    expect(row.audio_url).toBe('');
    expect(row.audio_stale).toBe(false);
    expect(errors).toEqual([]);
  });

  it('新鮮なURLの再生エラーでは取り消さない', async () => {
    await seedStale(hoursAgoIso(1));
    fetchOneFeed.mockResolvedValue({
      feed: FEED, ok: true, error: null,
      entries: [entry({ audioUrl: FRESH_URL, durationSec: 1800 })],
    });
    await mountApp();
    el.querySelector('.play-btn').click();
    await flushUntil(() => latestAudio() && latestAudio().src === FRESH_URL);
    latestAudio().dispatchEvent(new window.Event('error'));
    // エラー処理が一巡しても、プレイヤーとボタンは残る。
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
      await nextTick();
    }
    expect(el.querySelector('.player-bar'), 'プレイヤーは残る').toBeTruthy();
    expect(el.querySelector('.play-btn'), 'ボタンは残る').toBeTruthy();
    const row = (await loadLocalArticles()).find((a) => a.id === staleId);
    expect(row.audio_url).toBe(FRESH_URL);
    expect(errors).toEqual([]);
  });
});
