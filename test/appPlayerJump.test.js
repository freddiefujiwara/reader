// プレイヤーから再生中の記事へのジャンプ (App.vue) のコンポーネント
// テスト。固定したい振る舞い: プレイヤーのタイトルを押すと、その
// 記事のフィード単体表示へ切り替わり、カードの上端が固定バー
// (ナビ＋絞り込みバー) の下にちょうど出る位置へスクロールする。
// スクロール後にレイアウトがずれた場合は、落ち着く頃に1回だけ
// 補正してからハイライトする。
// レイアウトは jsdom では実測できないため、getBoundingClientRect と
// scrollY / scrollTo を、文書座標モデルで差し替えて検証する。
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, nextTick } from 'vue';

const FEED_A_ID = 'b81e59da11f890d2'; // https://feeds.rebuild.fm/rebuildfm
const FEED_B_ID = '87e6ebcd1afd6416'; // https://anchor.fm/s/8c2088c/podcast/rss
const FEED_A = {
  id: FEED_A_ID, title: 'Rebuild', url: 'https://feeds.rebuild.fm/rebuildfm',
  category: 'ポッドキャスト', enabled: true, lastStatus: '200', lastError: '',
  lastFetchedAt: '', unreadCount: 2,
};
const FEED_B = {
  id: FEED_B_ID, title: 'コテンラジオ', url: 'https://anchor.fm/s/8c2088c/podcast/rss',
  category: '教養・ラジオ', enabled: true, lastStatus: '200', lastError: '',
  lastFetchedAt: '', unreadCount: 1,
};

const rec = (id, feed_id, title, published_at) => ({
  id,
  feed_id,
  title,
  link: `https://example.com/${id}`,
  published_at,
  fetched_at: '2026-11-15T00:00:00.000Z',
  summary: '',
  author: '',
  audio_url: `https://example.com/${id}.mp3`,
  duration_sec: 1800,
  play_pos: 0,
  is_read: false,
  read_at: '',
});
const A1 = rec('a1', FEED_A_ID, 'フィードAの新記事', '2026-11-15T00:00:00.000Z');
const B1 = rec('b1', FEED_B_ID, 'フィードBの記事', '2026-11-14T00:00:00.000Z');
const A2 = rec('a2', FEED_A_ID, 'フィードAの旧記事', '2026-11-13T00:00:00.000Z');

vi.mock('../src/lib/api.js', () => ({
  setStar: vi.fn(async () => ({ ok: true })),
  deleteFeed: vi.fn(async () => ({ ok: true })),
  exchangeSession: vi.fn(async () => ({ ok: true })),
  exchangeShare: vi.fn(async () => ({ ok: true })),
  listArticles: vi.fn(async () => ({ ok: true, feeds: [FEED_A, FEED_B], articles: [] })),
  listFeeds: vi.fn(async () => ({ ok: true, feeds: [FEED_A, FEED_B] })),
  getShareLinkStatus: vi.fn(async () => ({ ok: true, active: false, expiresAt: null })),
  getFeedStats: vi.fn(async () => ({ ok: true, stats: {} })),
  issueShareLink: vi.fn(async () => ({ ok: true, token: 'dummy-share-token', expiresAt: '2026-12-16T05:47:00.000Z' })),
  revokeShareLink: vi.fn(async () => ({ ok: true })),
  logEvents: vi.fn(async () => ({ ok: true, saved: 0 })),
  reorderFeeds: vi.fn(async () => ({ ok: true })),
  saveFeed: vi.fn(async () => ({ ok: true, feed: FEED_A })),
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
import { saveLocalFeeds, putLocalArticles } from '../src/lib/localDb.js';

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

// 文書座標モデル: 絞り込みバーの下端は 170 (固定)、対象カードの
// 文書上の上端は cardDocTop。scrollTo で scrollY が動き、カードの
// ビューポート上の位置は cardDocTop - scrollY になる。
let scrollYValue = 0;
let cardDocTop = 1000;
const scrollCalls = [];

function installLayoutStubs() {
  scrollYValue = 0;
  cardDocTop = 1000;
  scrollCalls.length = 0;
  Object.defineProperty(window, 'scrollY', { get: () => scrollYValue, configurable: true });
  window.scrollTo = (opts) => {
    scrollCalls.push(opts);
    if (opts && typeof opts.top === 'number') scrollYValue = opts.top;
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const base = { left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
    if (this.classList && this.classList.contains('filter-bar')) {
      return { ...base, top: 64, bottom: 170 };
    }
    if (this.dataset && this.dataset.articleId === 'b1') {
      const top = cardDocTop - scrollYValue;
      return { ...base, top, bottom: top + 120, height: 120 };
    }
    return { ...base, top: 0, bottom: 0 };
  };
}

let app = null;
let el = null;
let errors = [];

const flush = async () => {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  installLayoutStubs();
});

afterEach(() => {
  if (app) app.unmount();
  app = null;
  el = null;
  vi.unstubAllGlobals();
});

describe('プレイヤーから記事へのジャンプ', () => {
  it('フィード表示へ切り替わり、固定バーの下へスクロールし、ずれを補正して光る', async () => {
    await saveLocalFeeds([FEED_A, FEED_B]);
    await putLocalArticles([{ ...A1 }, { ...B1 }, { ...A2 }]);
    el = document.createElement('div');
    document.body.appendChild(el);
    app = createApp(App);
    app.config.errorHandler = (err) => { errors.push(err); };
    app.mount(el);
    await flush();
    expect(el.querySelectorAll('.article-card').length, '全件表示で3件出る').toBe(3);

    // フィードBの記事を再生する。
    const b1Card = el.querySelector('[data-article-id="b1"]');
    b1Card.querySelector('.play-btn').click();
    await flush();
    expect(el.querySelector('.player-title').textContent).toBe('フィードBの記事');

    // プレイヤーのタイトルを押す。
    scrollCalls.length = 0;
    el.querySelector('.player-jump').click();
    await flush();
    expect(errors).toEqual([]);
    // フィードBの単体表示になり、カードは1件だけ。
    const cards = el.querySelectorAll('.article-card');
    expect(cards.length).toBe(1);
    expect(cards[0].dataset.articleId).toBe('b1');
    // カード上端 (文書座標 1000) が、バー下端 170 ＋余白 8 の位置に
    // 来るようスクロールする: 1000 - 178 = 822。
    expect(scrollCalls[0]).toEqual({ top: 822, behavior: 'smooth' });

    // スクロール後にレイアウトが 40px 伸びた (要約の再計測など) 状況で、
    // 落ち着く頃の補正が入る。
    cardDocTop = 1040;
    await sleep(750);
    await flush();
    expect(scrollCalls[1]).toEqual({ top: 862, behavior: 'auto' });
    expect(el.querySelector('[data-article-id="b1"]').classList.contains('is-flash')).toBe(true);
    expect(errors).toEqual([]);
  });
});
