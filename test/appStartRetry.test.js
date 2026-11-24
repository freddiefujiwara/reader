// 遷移直後の再生開始チェック (開始ウォッチドッグ) のコンポーネント
// テスト。API と取得経路だけをモックし、記事は IndexedDB
// (fake-indexeddb) へ種まきして実際の App をマウントする。
// 固定したい振る舞い:
// - 曲の終了遷移 (役割交代) で新しい側の play() が NotAllowedError
//   で拒否されたら、失敗として曲を飛ばさず、その場で再発行し、
//   それでも始まらなければ直前まで鳴っていた要素へ読み直して
//   再生する (フォールバック)。
// - フォールバック先でも拒否されたら打ち止め、診断
//   (play_rejected_* / start_retry / start_fallback /
//   start_failed) が理由つきで残る。
// - 正常に開始した場合は、再発行もフォールバックも起きない。
// - play() が解決しても 'playing' が来ない場合は、タイマーの
//   tick で再発行され、フォールバック先が無ければ打ち止める。
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
import { logEvents } from '../src/lib/api.js';
import { loadLocalArticles, saveLocalFeeds, putLocalArticles, deleteLocalArticles } from '../src/lib/localDb.js';

// 要素ごとに play() の振る舞いを差し替えられるスタブ。
// playHook (要素を受け取り、拒否するエラーの name か null を返す)
// が name を返した間は、その要素の play() が拒否される。
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
    this.playHook = null;
  }

  play() {
    this.playCalls += 1;
    const rejectName = this.playHook ? this.playHook(this) : null;
    if (rejectName) {
      const err = new Error(rejectName);
      err.name = rejectName;
      return Promise.reject(err);
    }
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

async function startCard(idx) {
  el.querySelectorAll('.article-card')[idx].querySelector('.play-btn').click();
  await flush();
  return el.querySelector('.player-bar');
}

// 指定した要素で曲が終わったことにする (appPlayer の fireEnded と
// 同じ作りだが、交代後はアクティブな要素が最新とは限らないため
// 要素を明示する)。
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

describe('遷移直後に play() がブロックされたときの開始チェック', () => {
  // EP1 を deckA で再生し ('playing' で先読みが deckB へ張られる)、
  // 終了で役割交代して EP2 が deckB へ移る形を作る。
  async function startAndPreload() {
    await mountWith([EP1, EP2]);
    await startCard(0);
    const deckA = audioInstances[0];
    deckA.dispatchEvent(new window.Event('playing'));
    await flush();
    expect(audioInstances.length).toBe(2);
    const deckB = audioInstances[1];
    expect(deckB.src).toBe('https://example.com/ep2.mp3');
    return { deckA, deckB };
  }

  it('交代先が拒否されたら再発行し、それでも始まらなければ直前まで鳴っていた要素へ読み直して再生する', async () => {
    const { deckA, deckB } = await startAndPreload();
    // 交代先 (deckB) の play() は常に NotAllowedError で拒否される。
    deckB.playHook = () => 'NotAllowedError';

    await endDeck(deckA);
    expect(errors).toEqual([]);
    // 曲は飛ばされず EP2 のまま。フォールバックで deckA が
    // アクティブに戻り、EP2 を読み直して再生が始まっている。
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(deckB.playCalls, '交代先は初回+再発行の2回試される').toBe(2);
    expect(deckB.src, '失敗した側は待機側として空に戻る').toBe('');
    expect(deckA.src).toBe('https://example.com/ep2.mp3');
    expect(deckA.playCalls, 'deckA は EP1 の開始とフォールバックの2回').toBe(2);
    expect(deckA.paused).toBe(false);

    // 実際に開始したことにする (ウォッチドッグが解除される)。
    deckA.dispatchEvent(new window.Event('playing'));
    await flush();
    // 終了の区切りでキューが送られ、診断が理由つきで残る。
    await endDeck(deckA);
    expect(errors).toEqual([]);
    expect(eventsOf('advance_swap', 'ep-2').length).toBe(1);
    expect(eventsOf('play_rejected_not_allowed', 'ep-2').length).toBe(2);
    expect(eventsOf('start_retry', 'ep-2').length).toBe(1);
    expect(eventsOf('start_fallback', 'ep-2').length).toBe(1);
    expect(eventsOf('start_failed', 'ep-2')).toEqual([]);
  });

  it('フォールバック先でも拒否されたら打ち止め、start_failed が残る', async () => {
    const { deckA, deckB } = await startAndPreload();
    deckB.playHook = () => 'NotAllowedError';
    // deckA も EP2 に対しては拒否される (EP1 の開始は通常どおり)。
    deckA.playHook = (a) => (a.src.includes('ep2') ? 'NotAllowedError' : null);

    await endDeck(deckA);
    expect(errors).toEqual([]);
    // 曲は飛ばされず EP2 のまま止まる (従来はこの状態のまま
    // フォアグラウンド復帰まで残った)。
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(deckB.playCalls).toBe(2);
    expect(deckA.playCalls).toBe(2);
    expect(deckA.paused).toBe(true);

    // フォアグラウンド復帰の区切りでキューが送られる。
    document.dispatchEvent(new window.Event('visibilitychange'));
    await flush();
    expect(errors).toEqual([]);
    // 拒否は初回・再発行・フォールバックの3回分、理由つきで残る。
    expect(eventsOf('play_rejected_not_allowed', 'ep-2').length).toBe(3);
    expect(eventsOf('start_retry', 'ep-2').length).toBe(1);
    expect(eventsOf('start_fallback', 'ep-2').length).toBe(1);
    expect(eventsOf('start_failed', 'ep-2').length).toBe(1);
  });

  it('正常に開始した場合は、再発行もフォールバックも起きず、診断も残らない', async () => {
    await mountWith([EP1, EP2]);
    await startCard(0);
    const deckA = audioInstances[0];
    deckA.dispatchEvent(new window.Event('playing'));
    await flush();
    // 開始チェックの実行機会 ('canplay') を与えても何も起きない。
    deckA.dispatchEvent(new window.Event('canplay'));
    await flush();
    expect(errors).toEqual([]);
    expect(deckA.playCalls).toBe(1);
    // 終了の区切りでキューを送っても、開始系の診断は無い。
    await endDeck(deckA);
    expect(errors).toEqual([]);
    const startDiag = sentEvents().filter((e) => e.type.startsWith('start_') || e.type.startsWith('play_rejected'));
    expect(startDiag).toEqual([]);
  });
});

// 偽タイマーを入れる前に、本物の setTimeout を控えておく (ポンプ用)。
const realSetTimeout = globalThis.setTimeout;

describe("play() が解決しても 'playing' が来ないときの開始チェック", () => {
  // 終端チェックのタイマー (500ms) に相乗りする検知を、偽タイマーと
  // performance.now の操作で再現する (ストール検知のテストと同じ流儀)。
  async function mountFake(records) {
    const flushFake = async () => {
      for (let i = 0; i < 10; i += 1) {
        await vi.advanceTimersByTimeAsync(10);
        await new Promise((r) => realSetTimeout(r, 1));
        await nextTick();
      }
    };
    let seeded = false;
    const seeding = (async () => {
      const existing = await loadLocalArticles();
      if (existing.length) await deleteLocalArticles(existing.map((a) => a.id));
      await saveLocalFeeds([FEED]);
      await putLocalArticles(records.map((r) => ({ ...r })));
      seeded = true;
    })();
    for (let i = 0; i < 50 && !seeded; i += 1) await flushFake();
    await seeding;
    el = document.createElement('div');
    document.body.appendChild(el);
    app = createApp(App);
    app.config.errorHandler = (err) => { errors.push(err); };
    app.mount(el);
    for (let i = 0; i < 50 && el.querySelectorAll('.article-card').length < records.length; i += 1) {
      await flushFake();
    }
    expect(el.querySelectorAll('.article-card').length).toBe(records.length);
    return flushFake;
  }

  async function tick(flushFake, setNow) {
    setNow();
    await vi.advanceTimersByTimeAsync(500);
    await flushFake();
  }

  it('開始しないまま猶予を過ぎたら tick で再発行され、フォールバック先が無ければ打ち止める', async () => {
    vi.useFakeTimers();
    let nowVal = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => nowVal);
    try {
      const flushFake = await mountFake([EP1, EP2]);
      el.querySelectorAll('.article-card')[0].querySelector('.play-btn').click();
      await flushFake();
      const deckA = audioInstances[0];
      expect(deckA.playCalls).toBe(1);
      // 'playing' を送らない = play() は解決したのに開始しない状態。
      // 猶予 (3秒) の内は再発行されない。
      await tick(flushFake, () => { nowVal = 2_500; });
      expect(deckA.playCalls).toBe(1);
      // 猶予を過ぎたら tick で再発行される。
      await tick(flushFake, () => { nowVal = 3_500; });
      expect(errors).toEqual([]);
      expect(deckA.playCalls).toBe(2);
      expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
      // 再発行後も始まらなければ、フォールバック先 (直前まで
      // 鳴っていた要素) が無いため打ち止め、それ以上は試さない。
      await tick(flushFake, () => { nowVal = 9_000; });
      await tick(flushFake, () => { nowVal = 30_000; });
      expect(errors).toEqual([]);
      expect(deckA.playCalls).toBe(2);

      // 終了の区切りでキューが送られ、診断が残る。
      deckA.ended = true;
      deckA.paused = true;
      deckA.dispatchEvent(new window.Event('ended'));
      await flushFake();
      expect(errors).toEqual([]);
      expect(eventsOf('start_retry', 'ep-1').length).toBe(1);
      expect(eventsOf('start_failed', 'ep-1').length).toBe(1);
      expect(eventsOf('start_fallback', 'ep-1')).toEqual([]);
    } finally {
      nowSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
