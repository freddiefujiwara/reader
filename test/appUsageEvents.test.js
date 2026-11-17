// 視聴ログ (feed_view / article_open / play / scroll) の送信と、
// 管理画面の「今週の視聴」表示のコンポーネントテスト。
// 固定したい振る舞い:
// - feed_view はフィード選択の変更時だけ送り、初期表示・背景更新・
//   ジャンル変更・選択解除では送らない。
// - scroll はフィード選択中にスクロールしたとき、その訪問につき
//   1回だけ送る。すべて表示では送らない。
// - article_open は記事タイトルを開いたときに送る。聴き終えた
//   ときの既読化では送らない (play とは別に数える)。
// - play は再生が止まった区切りで、実再生時間 (一時停止を除く)
//   を送る。5秒未満は送らない。
// - 読み取り専用では何も送らない。
// - 管理画面を開くと stats を1回だけ取得し、今週分を表示する。
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, nextTick } from 'vue';

const FEED_A = {
  id: 'b81e59da11f890d2', // https://feeds.rebuild.fm/rebuildfm のハッシュID
  title: 'Rebuild',
  url: 'https://feeds.rebuild.fm/rebuildfm',
  category: 'ポッドキャスト',
  lastStatus: '200',
  lastError: '',
  lastFetchedAt: '2026-11-15T01:00:00.000Z',
  unreadCount: 2,
};
const FEED_B = {
  id: '33452296be85fdbc', // https://example.com/x.freddie.xml のハッシュID
  title: 'X freddie',
  url: 'https://example.com/x.freddie.xml',
  category: 'private',
  lastStatus: '200',
  lastError: '',
  lastFetchedAt: '2026-11-15T01:00:00.000Z',
  unreadCount: 1,
};

let serverFeeds = [];

vi.mock('../src/lib/api.js', () => ({
  setStar: vi.fn(async () => ({ ok: true })),
  deleteFeed: vi.fn(async () => ({ ok: true })),
  exchangeSession: vi.fn(async () => ({ ok: true })),
  exchangeShare: vi.fn(async () => ({ ok: true })),
  listArticles: vi.fn(async () => ({
    ok: true,
    feeds: serverFeeds.map((f) => ({ ...f })),
    articles: [],
  })),
  listFeeds: vi.fn(async () => ({ ok: true, feeds: serverFeeds.map((f) => ({ ...f })) })),
  getShareLinkStatus: vi.fn(async () => ({ ok: true, active: false, expiresAt: null })),
  issueShareLink: vi.fn(async () => ({ ok: true, token: 'dummy-share-token', expiresAt: '2026-12-16T05:47:00.000Z' })),
  revokeShareLink: vi.fn(async () => ({ ok: true })),
  logEvents: vi.fn(async () => ({ ok: true, saved: 0 })),
  getStats: vi.fn(async () => ({ ok: true, weekly: [], currentWeek: '', current: [] })),
  reorderFeeds: vi.fn(async () => ({ ok: true })),
  saveFeed: vi.fn(async () => ({ ok: true })),
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
import { logEvents, getStats } from '../src/lib/api.js';
import { saveLocalFeeds, putLocalArticles } from '../src/lib/localDb.js';

const rec = (id, feedId, title, published_at, audio_url = '') => ({
  id,
  feed_id: feedId,
  title,
  link: `https://example.com/${id}`,
  published_at,
  fetched_at: '2026-11-15T00:00:00.000Z',
  summary: '',
  author: '',
  audio_url,
  duration_sec: audio_url ? 1800 : 0,
  play_pos: 0,
  is_read: false,
  read_at: '',
});
const EP1 = rec('ep-1', FEED_A.id, 'エピソード1', '2026-11-14T00:00:00.000Z', 'https://example.com/ep1.mp3');
const EP2 = rec('ep-2', FEED_A.id, 'エピソード2', '2026-11-13T00:00:00.000Z', 'https://example.com/ep2.mp3');
const ART_B = rec('art-b', FEED_B.id, '記事B', '2026-11-12T00:00:00.000Z');

// jsdom の HTMLMediaElement は再生を実装しないため、イベントを
// 発火できる最小のスタブに差し替える (appPlayer と同じ)。
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
let fakeNow = 0;
let nowSpy = null;

const flushRound = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
};

const flushUntil = async (cond, maxRounds = 120) => {
  for (let i = 0; i < maxRounds; i += 1) {
    if (await cond()) return true;
    await flushRound();
  }
  return !!(await cond());
};

const isRefreshingShown = () =>
  !!el && [...el.querySelectorAll('button')].some((b) => b.textContent.includes('更新中'));

const settleApp = async (maxRounds = 120) => {
  if (!el) return;
  let calm = 0;
  for (let i = 0; i < maxRounds && calm < 3; i += 1) {
    await flushRound();
    calm = isRefreshingShown() ? 0 : calm + 1;
  }
};

function findButton(root, text) {
  return [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
}

const feedChips = () => [...el.querySelectorAll('[aria-label="フィードで絞り込み"] .chip')];
const cardByTitle = (title) =>
  [...el.querySelectorAll('.article-card')].find((c) => c.querySelector('.article-title').textContent.trim() === title);
const latestAudio = () => audioInstances[audioInstances.length - 1];

// logEvents へ渡ったイベントをすべて平らに集める。
const sentEvents = () => logEvents.mock.calls.flatMap((c) => c[1]);

async function seedAndMount(role = 'owner') {
  await saveLocalFeeds([{ ...FEED_A }, { ...FEED_B }]);
  await putLocalArticles([{ ...EP1 }, { ...EP2 }, { ...ART_B }]);
  window.history.pushState(null, '', '/reader/');
  localStorage.setItem(
    'reader:session:v1',
    JSON.stringify({ token: 'tok', role, expiresAt: null })
  );
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
  await flushUntil(() => el.querySelectorAll('.article-card').length === 3);
  await settleApp();
}

beforeEach(() => {
  errors = [];
  audioInstances.length = 0;
  serverFeeds = [{ ...FEED_A }, { ...FEED_B }];
  document.body.innerHTML = '';
  window.scrollTo = function () {};
  localStorage.clear();
  fakeNow = 1_000_000;
  nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => fakeNow);
  vi.stubGlobal('Audio', FakeAudio);
  vi.clearAllMocks();
  getStats.mockImplementation(async () => ({ ok: true, weekly: [], currentWeek: '2026-11-16', current: [] }));
});

afterEach(async () => {
  await settleApp();
  if (app) app.unmount();
  app = null;
  el = null;
  nowSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe('feed_view の送信', () => {
  it('初期表示と背景更新では送らず、フィード選択の変更時だけ送る', async () => {
    await seedAndMount();
    expect(errors).toEqual([]);
    expect(logEvents).not.toHaveBeenCalled();

    // 手動の背景更新でも送らない。
    findButton(el, '更新').click();
    await settleApp();
    expect(logEvents).not.toHaveBeenCalled();

    // フィードを選ぶと、そのフィードの feed_view が1件送られる。
    feedChips().find((b) => b.textContent.includes('X freddie')).click();
    await flushUntil(() => logEvents.mock.calls.length === 1);
    expect(logEvents).toHaveBeenCalledWith('tok', [
      expect.objectContaining({ type: 'feed_view', feed_id: FEED_B.id, feed_title: 'X freddie' }),
    ]);

    // ジャンルだけの変更では送らない。
    findButton(el.querySelector('[aria-label="カテゴリで絞り込み"]'), 'ポッドキャスト').click();
    await settleApp();
    expect(logEvents).toHaveBeenCalledTimes(1);

    // フィードを選び直すと、その分が送られる。
    feedChips().find((b) => b.textContent.includes('Rebuild')).click();
    await flushUntil(() => logEvents.mock.calls.length === 2);
    expect(sentEvents()[1]).toEqual(
      expect.objectContaining({ type: 'feed_view', feed_id: FEED_A.id, feed_title: 'Rebuild' })
    );

    // 選択の解除 (全件表示に戻る) では送らない。
    feedChips().find((b) => b.textContent.includes('Rebuild')).click();
    await settleApp();
    expect(logEvents).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([]);
  });
});

describe('article_open の送信', () => {
  it('記事タイトルを開くと送られ、既読の記事を開いても送られる', async () => {
    await seedAndMount();
    cardByTitle('記事B').querySelector('.article-title a').click();
    await flushUntil(() => logEvents.mock.calls.length === 1);
    expect(sentEvents()).toEqual([
      expect.objectContaining({
        type: 'article_open',
        feed_id: FEED_B.id,
        feed_title: 'X freddie',
        article_id: 'art-b',
        article_title: '記事B',
      }),
    ]);
    // 既読になった記事をもう一度開いても、開いた操作として数える。
    cardByTitle('記事B').querySelector('.article-title a').click();
    await flushUntil(() => logEvents.mock.calls.length === 2);
    expect(sentEvents()[1]).toEqual(expect.objectContaining({ type: 'article_open', article_id: 'art-b' }));
    expect(errors).toEqual([]);
  });
});

describe('scroll の送信', () => {
  const scrollEvents = () => sentEvents().filter((e) => e.type === 'scroll');

  function dispatchScroll(y) {
    Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
    window.dispatchEvent(new window.Event('scroll'));
  }

  it('フィード選択中は訪問ごとに1回だけ送り、フィードを変えると新しい分が送られる', async () => {
    await seedAndMount();
    // すべて表示では、スクロールしても送らない。
    dispatchScroll(120);
    await settleApp();
    expect(logEvents).not.toHaveBeenCalled();

    // フィードを選ぶ (feed_view が1件送られる)。
    feedChips().find((b) => b.textContent.includes('X freddie')).click();
    await flushUntil(() => logEvents.mock.calls.length === 1);

    // スクロールすると、そのフィードの scroll が1件送られる。
    dispatchScroll(120);
    await flushUntil(() => scrollEvents().length === 1);
    expect(scrollEvents()[0]).toEqual(
      expect.objectContaining({
        type: 'scroll',
        feed_id: FEED_B.id,
        feed_title: 'X freddie',
        article_id: '',
        article_title: '',
      })
    );

    // 同じ訪問で何度スクロールしても増えない。
    dispatchScroll(240);
    dispatchScroll(360);
    await settleApp();
    expect(scrollEvents()).toHaveLength(1);

    // フィードを変えてスクロールすると、そのフィード分が送られる。
    feedChips().find((b) => b.textContent.includes('Rebuild')).click();
    await flushUntil(() => sentEvents().filter((e) => e.type === 'feed_view').length === 2);
    dispatchScroll(120);
    await flushUntil(() => scrollEvents().length === 2);
    expect(scrollEvents()[1]).toEqual(
      expect.objectContaining({ type: 'scroll', feed_id: FEED_A.id, feed_title: 'Rebuild' })
    );
    expect(errors).toEqual([]);
  });

  it('先頭へ戻る動き (scrollY が 0) では送らない', async () => {
    await seedAndMount();
    feedChips().find((b) => b.textContent.includes('X freddie')).click();
    await flushUntil(() => logEvents.mock.calls.length === 1);
    dispatchScroll(0);
    await settleApp();
    expect(scrollEvents()).toHaveLength(0);
    expect(errors).toEqual([]);
  });
});

describe('play の送信', () => {
  async function startCard(title) {
    cardByTitle(title).querySelector('.play-btn').click();
    await flushRound();
    expect(el.querySelector('.player-bar'), 'プレイヤーバーが出る').toBeTruthy();
  }

  it('止めた区切りで実再生時間を送る (一時停止の間は数えない)', async () => {
    await seedAndMount();
    await startCard('エピソード1');
    fakeNow += 10_000;
    latestAudio().pause();
    fakeNow += 60_000; // 一時停止中の時間は数えない
    latestAudio().play();
    fakeNow += 20_000;
    el.querySelector('.player-close').click();
    await flushUntil(() => logEvents.mock.calls.length === 1);
    expect(sentEvents()).toEqual([
      expect.objectContaining({
        type: 'play',
        feed_id: FEED_A.id,
        feed_title: 'Rebuild',
        article_id: 'ep-1',
        article_title: 'エピソード1',
        seconds: 30,
      }),
    ]);
    expect(errors).toEqual([]);
  });

  it('5秒未満の再生は送らない', async () => {
    await seedAndMount();
    await startCard('エピソード1');
    fakeNow += 3_000;
    el.querySelector('.player-close').click();
    await settleApp();
    expect(logEvents).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it('別の曲へ切り替えると、前の曲の分が送られる', async () => {
    await seedAndMount();
    await startCard('エピソード1');
    fakeNow += 10_000;
    await startCard('エピソード2');
    await flushUntil(() => logEvents.mock.calls.length === 1);
    expect(sentEvents()).toEqual([
      expect.objectContaining({ type: 'play', article_id: 'ep-1', seconds: 10 }),
    ]);
    expect(errors).toEqual([]);
  });

  it('聴き終えて次へ進んでも article_open は送られない (play だけが数える)', async () => {
    await seedAndMount();
    await startCard('エピソード1');
    fakeNow += 40_000;
    const audio = latestAudio();
    audio.ended = true;
    audio.paused = true;
    audio.dispatchEvent(new window.Event('ended'));
    await flushUntil(() => logEvents.mock.calls.length === 1);
    expect(sentEvents()).toEqual([
      expect.objectContaining({ type: 'play', article_id: 'ep-1', seconds: 40 }),
    ]);
    expect(errors).toEqual([]);
  });
});

describe('読み取り専用では送らない', () => {
  it('フィード切替でも logEvents は呼ばれない', async () => {
    await seedAndMount('readonly');
    feedChips().find((b) => b.textContent.includes('X freddie')).click();
    await settleApp();
    expect(logEvents).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it('スクロールしても scroll は送られない', async () => {
    await seedAndMount('readonly');
    feedChips().find((b) => b.textContent.includes('X freddie')).click();
    await settleApp();
    Object.defineProperty(window, 'scrollY', { value: 120, configurable: true });
    window.dispatchEvent(new window.Event('scroll'));
    await settleApp();
    expect(logEvents).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });
});

describe('今週の視聴の表示', () => {
  async function openAdmin() {
    findButton(el, '管理').click();
    await flushUntil(() => !!el.querySelector('.usage-stats-panel'));
    return el.querySelector('.usage-stats-panel');
  }

  it('管理画面を開くと stats を1回取得し、再生時間の長い順に表示する', async () => {
    getStats.mockImplementation(async () => ({
      ok: true,
      weekly: [],
      currentWeek: '2026-11-16',
      current: [
        { week: '2026-11-16', feed_id: FEED_B.id, feed_title: 'X freddie', views: 3, opens: 1, plays: 2, seconds: 300 },
        { week: '2026-11-16', feed_id: FEED_A.id, feed_title: 'Rebuild', views: 1, opens: 4, plays: 5, seconds: 3661 },
        { week: '2026-11-16', feed_id: 'views-only', feed_title: '見ただけ', views: 9, opens: 9, plays: 0, seconds: 0 },
      ],
    }));
    await seedAndMount();
    const panel = await openAdmin();
    expect(getStats).toHaveBeenCalledTimes(1);
    expect(getStats).toHaveBeenCalledWith('tok');
    const rows = [...panel.querySelectorAll('.usage-stats-list li')];
    // 再生があったフィードだけを、再生時間の長い順に出す。
    expect(rows.map((li) => li.querySelector('.usage-stats-feed').textContent)).toEqual(['Rebuild', 'X freddie']);
    expect(rows[0].querySelector('.usage-stats-meta').textContent).toBe('1:01:01・5回');
    expect(rows[1].querySelector('.usage-stats-meta').textContent).toBe('5:00・2回');
    expect(errors).toEqual([]);
  });

  it('今週の再生が無ければ、その旨が出る', async () => {
    await seedAndMount();
    const panel = await openAdmin();
    expect(panel.textContent).toContain('今週の再生はまだありません。');
    expect(errors).toEqual([]);
  });

  it('取得に失敗するとエラーが出る', async () => {
    getStats.mockImplementation(async () => { throw new Error('boom'); });
    await seedAndMount();
    const panel = await openAdmin();
    await flushUntil(() => panel.textContent.includes('視聴集計を取得できませんでした'));
    expect(panel.textContent).toContain('視聴集計を取得できませんでした（boom）。');
    expect(errors).toEqual([]);
  });
});
