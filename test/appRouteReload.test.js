// 回線切り替わり時の読み直しのコンポーネントテスト。API と
// 取得経路だけをモックし、記事は IndexedDB (fake-indexeddb) へ
// 種まきして実際の App をマウントする。
// 固定したい振る舞い:
// - 再生中に 'offline' → 'online' を受けたら、再生中の曲を
//   もう一方の要素へ現在位置から読み直す (位置はメタデータ
//   経由で復元され、曲の末尾は切り捨てない)。
// - 診断 (route_offline / route_online / route_reload) が、
//   読み直し位置つきで残る。
// - 本人が一時停止している間は読み直さない (回線イベントの
//   記録だけは残る)。
// - 回線イベントが連続しても、読み直しは1回にまとまる。
// - 終端間際では読み直さず、その印は後の正常な位置での
//   イベントで使える (ガードの消費順序)。
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
  unreadCount: 2,
};

const rec = (id, title, published_at, audio_url) => ({
  id,
  feed_id: FEED_ID,
  title,
  link: `https://example.com/${id}`,
  published_at,
  fetched_at: '2026-11-15T00:00:00.000Z',
  summary: '',
  author: '',
  audio_url,
  duration_sec: 1800,
  play_pos: 0,
  is_read: false,
  read_at: '',
});
const EP1 = rec('ep-1', 'エピソード1', '2026-11-14T00:00:00.000Z', 'https://example.com/ep1.mp3');
const EP2 = rec('ep-2', 'エピソード2', '2026-11-13T00:00:00.000Z', 'https://example.com/ep2.mp3');

vi.mock('../src/lib/api.js', () => ({
  setStar: vi.fn(async () => ({ ok: true })),
  deleteFeed: vi.fn(async () => ({ ok: true })),
  exchangeSession: vi.fn(async () => ({ ok: true })),
  exchangeShare: vi.fn(async () => ({ ok: true })),
  listArticles: vi.fn(async () => ({ ok: true, feeds: [FEED], articles: [] })),
  listFeeds: vi.fn(async () => ({ ok: true, feeds: [FEED] })),
  getShareLinkStatus: vi.fn(async () => ({ ok: true, active: false, expiresAt: null })),
  issueShareLink: vi.fn(async () => ({ ok: true, token: 'dummy-share-token', expiresAt: '2026-12-16T05:47:00.000Z' })),
  revokeShareLink: vi.fn(async () => ({ ok: true })),
  logEvents: vi.fn(async () => ({ ok: true, saved: 0 })),
  getStats: vi.fn(async () => ({ ok: true, weekly: [], currentWeek: '', current: [] })),
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
import { logEvents } from '../src/lib/api.js';
import { loadLocalArticles, saveLocalFeeds, putLocalArticles, deleteLocalArticles } from '../src/lib/localDb.js';

// 要素のスタブ (appStartRetry と同じ作り)。
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
    this.playCalls = 0;
  }

  play() {
    this.playCalls += 1;
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

// logEvents へ渡ったイベントをすべて平らに集める。
const sentEvents = () => logEvents.mock.calls.flatMap((c) => c[1]);
const eventsOf = (type, articleId) => sentEvents()
  .filter((e) => e.type === type && (!articleId || e.article_id === articleId));

const flush = async () => {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();
  }
};

async function flushUntil(cond, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('flushUntil: 条件が満たされませんでした');
  }
}

async function mountWith(records) {
  const existing = await loadLocalArticles();
  if (existing.length) await deleteLocalArticles(existing.map((a) => a.id));
  await saveLocalFeeds([FEED]);
  await putLocalArticles(records.map((r) => ({ ...r })));
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
  await flushUntil(() => el.querySelectorAll('.article-card').length === records.length);
}

// EP1 を deckA で再生開始し、メタデータ (長さ1800) と 'playing'
// まで進める。先読みで deckB に EP2 が張られる。
async function startPlaying() {
  await mountWith([EP1, EP2]);
  el.querySelectorAll('.article-card')[0].querySelector('.play-btn').click();
  await flush();
  const deckA = audioInstances[0];
  deckA.duration = 1800;
  deckA.dispatchEvent(new window.Event('loadedmetadata'));
  deckA.dispatchEvent(new window.Event('playing'));
  await flush();
  expect(audioInstances.length).toBe(2);
  const deckB = audioInstances[1];
  expect(deckB.src).toBe('https://example.com/ep2.mp3');
  return { deckA, deckB };
}

function fireRoute(kind) {
  window.dispatchEvent(new window.Event(kind));
}

// 指定した要素で曲が終わったことにする (診断キューの送信は、
// 次曲への遷移時の flush に相乗りする)。
async function endDeck(deck) {
  deck.ended = true;
  deck.paused = true;
  deck.dispatchEvent(new window.Event('ended'));
  await flush();
}

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

describe('回線切り替わり時の読み直し', () => {
  it('再生中に回線が切り替わったら、現在位置からもう一方の要素へ読み直し、診断が残る', async () => {
    const { deckA, deckB } = await startPlaying();
    deckA.currentTime = 600;

    fireRoute('offline');
    await flush();
    // 'offline' の時点では読み直さない (戻ってから行う)。
    expect(deckA.src).toBe('https://example.com/ep1.mp3');
    expect(deckB.src).toBe('https://example.com/ep2.mp3');

    fireRoute('online');
    await flush();
    expect(errors).toEqual([]);
    // 曲は EP1 のまま、アクティブが deckB へ移って読み直された。
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(deckB.src).toBe('https://example.com/ep1.mp3');
    expect(deckB.playCalls).toBe(1);
    expect(deckB.paused).toBe(false);
    // 失敗側 (deckA) は止めて空に戻る。
    expect(deckA.paused).toBe(true);
    expect(deckA.src).toBe('');

    // メタデータが来たら、読み直し位置 (600秒) が復元される。
    deckB.duration = 1800;
    deckB.dispatchEvent(new window.Event('loadedmetadata'));
    await flush();
    expect(deckB.currentTime).toBe(600);

    // 開始したことにし、曲の終わりで診断キューを送る。
    deckB.dispatchEvent(new window.Event('playing'));
    await flush();
    await endDeck(deckB);
    expect(errors).toEqual([]);
    expect(eventsOf('route_offline', 'ep-1').length).toBe(1);
    expect(eventsOf('route_online', 'ep-1').length).toBe(1);
    const reloads = eventsOf('route_reload', 'ep-1');
    expect(reloads.length).toBe(1);
    expect(reloads[0].seconds).toBe(600);
  });

  it('本人が一時停止している間は読み直さず、回線イベントの記録だけが残る', async () => {
    const { deckA, deckB } = await startPlaying();
    deckA.currentTime = 600;
    // 再生中のカードのボタンをもう一度押す = 本人の一時停止。
    el.querySelectorAll('.article-card')[0].querySelector('.play-btn').click();
    await flush();
    expect(deckA.paused).toBe(true);
    const playCallsBefore = deckA.playCalls + deckB.playCalls;

    fireRoute('offline');
    fireRoute('online');
    await flush();
    expect(errors).toEqual([]);
    // 読み直しは起きない (要素も位置もそのまま)。
    expect(deckA.src).toBe('https://example.com/ep1.mp3');
    expect(deckB.src).toBe('https://example.com/ep2.mp3');
    expect(deckA.playCalls + deckB.playCalls).toBe(playCallsBefore);

    // 再開して曲を終わらせると、区切りでキューが送られる。
    // 回線イベントは記録されているが、route_reload は無い。
    el.querySelectorAll('.article-card')[0].querySelector('.play-btn').click();
    await flush();
    deckA.dispatchEvent(new window.Event('playing'));
    await flush();
    await endDeck(deckA);
    expect(errors).toEqual([]);
    expect(eventsOf('route_offline', 'ep-1').length).toBe(1);
    expect(eventsOf('route_online', 'ep-1').length).toBe(1);
    expect(eventsOf('route_reload', 'ep-1')).toEqual([]);
  });

  it('回線イベントが連続しても、読み直しは1回にまとまる', async () => {
    const { deckA, deckB } = await startPlaying();
    deckA.currentTime = 600;

    fireRoute('offline');
    fireRoute('online');
    fireRoute('offline');
    fireRoute('online');
    fireRoute('online');
    await flush();
    expect(errors).toEqual([]);
    // 読み直しは最初の1回だけ (deckB が EP1 を1回だけ再生する)。
    expect(deckB.src).toBe('https://example.com/ep1.mp3');
    expect(deckB.playCalls).toBe(1);
    expect(deckA.src).toBe('');

    deckB.duration = 1800;
    deckB.dispatchEvent(new window.Event('loadedmetadata'));
    deckB.dispatchEvent(new window.Event('playing'));
    await flush();
    await endDeck(deckB);
    expect(errors).toEqual([]);
    expect(eventsOf('route_reload', 'ep-1').length).toBe(1);
  });

  it('終端間際では読み直さず、位置を戻せば後のイベントで読み直せる', async () => {
    const { deckA, deckB } = await startPlaying();
    // 残り3秒 (終端ガードの内側)。
    deckA.currentTime = 1797;
    fireRoute('offline');
    fireRoute('online');
    await flush();
    expect(errors).toEqual([]);
    expect(deckA.src).toBe('https://example.com/ep1.mp3');
    expect(deckB.src).toBe('https://example.com/ep2.mp3');
    expect(deckB.playCalls).toBe(0);

    // 位置が正常な範囲に戻れば、次の回線イベントで読み直す
    // (終端ガードで印が消費されていないことの確認)。
    deckA.currentTime = 600;
    fireRoute('online');
    await flush();
    expect(errors).toEqual([]);
    expect(deckB.src).toBe('https://example.com/ep1.mp3');
    expect(deckB.playCalls).toBe(1);
  });
});
