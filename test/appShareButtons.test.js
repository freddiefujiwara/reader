// 記事カードの SNS 共有ボタン (App.vue) のコンポーネントテスト。
// API と取得経路だけをモックし、記事は IndexedDB (fake-indexeddb)
// へ種まきして実際の App をマウントする (ハーネスは appStar と同じ)。
// 固定したい振る舞い:
// - 全記事 (YouTube / その他とも) に X / Facebook / Threads の
//   共有リンクとリンクコピーボタンが出る。リンクは別タブで開く。
// - 共有 URL は元リンクとタイトルから組み立てられる。
// - コピーは元リンクをクリップボードへ入れ、成功した記事の
//   ボタンだけ「コピーしました」表示になる。
// - 読み取り専用 (共有リンク) セッションでも共有ボタンは出る。
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, nextTick } from 'vue';

// https://www.youtube.com/channel/UCabcdefghij1234567890 のハッシュID。
const YT_FEED_ID = '3995346beb8a4c3f';
const YT_FEED = {
  id: YT_FEED_ID,
  title: 'YTチャンネル',
  url: 'https://www.youtube.com/channel/UCabcdefghij1234567890',
  category: '音楽',
  lastStatus: '200',
  lastError: '',
  lastFetchedAt: '',
  unreadCount: 0,
};
// https://feeds.rebuild.fm/rebuildfm のハッシュID (feedHash で固定済み)。
const POD_FEED_ID = 'b81e59da11f890d2';
const POD_FEED = {
  id: POD_FEED_ID,
  title: 'Rebuild',
  url: 'https://feeds.rebuild.fm/rebuildfm',
  category: 'ポッドキャスト',
  lastStatus: '200',
  lastError: '',
  lastFetchedAt: '',
  unreadCount: 0,
};
const FEEDS = [YT_FEED, POD_FEED];

vi.mock('../src/lib/api.js', () => ({
  setStar: vi.fn(async () => ({ ok: true })),
  deleteFeed: vi.fn(async () => ({ ok: true })),
  exchangeSession: vi.fn(async () => ({ ok: true })),
  exchangeShare: vi.fn(async () => ({ ok: true })),
  listArticles: vi.fn(async () => ({
    ok: true,
    feeds: FEEDS.map((f) => ({ ...f })),
    articles: [],
  })),
  listFeeds: vi.fn(async () => ({ ok: true, feeds: FEEDS.map((f) => ({ ...f })) })),
  getShareLinkStatus: vi.fn(async () => ({ ok: true, active: false, expiresAt: null })),
  getFeedStats: vi.fn(async () => ({ ok: true, stats: {} })),
  issueShareLink: vi.fn(async () => ({ ok: true, token: 'dummy-share-token', expiresAt: '2026-12-16T05:47:00.000Z' })),
  revokeShareLink: vi.fn(async () => ({ ok: true })),
  logEvents: vi.fn(async () => ({ ok: true, saved: 0 })),
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
import { loadLocalArticles, saveLocalFeeds, putLocalArticles, deleteLocalArticles } from '../src/lib/localDb.js';
import { buildXShareUrl, buildFacebookShareUrl, buildThreadsShareUrl } from '../src/lib/shareArticle.js';

const rec = (id, feed_id, title, link, published_at) => ({
  id,
  feed_id,
  title,
  link,
  published_at,
  fetched_at: '2026-11-15T00:00:00.000Z',
  summary: '',
  author: '',
  audio_url: '',
  audio_url_at: '',
  audio_stale: false,
  duration_sec: 0,
  play_pos: 0,
  is_read: false,
  read_at: '',
  starred: false,
  star_state: '',
});

// jsdom の HTMLMediaElement は再生を実装しないため、App が使う
// 面だけを持つスタブにする (appStar と同じ)。
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
let writeText = null;

const flushRound = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
};

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await flushRound();
};

const flushUntil = async (cond, maxRounds = 120) => {
  for (let i = 0; i < maxRounds; i += 1) {
    if (await cond()) return true;
    await flushRound();
  }
  return !!(await cond());
};

async function mountApp(records) {
  await saveLocalFeeds(FEEDS.map((f) => ({ ...f })));
  await putLocalArticles(records);
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
  await flush();
  await flushUntil(() => el.querySelectorAll('.article-card').length > 0);
  expect(errors).toEqual([]);
}

const cardByTitle = (title) =>
  [...el.querySelectorAll('.article-card')].find(
    (c) => c.querySelector('.article-title').textContent === title
  );

const shareAnchor = (card, label) =>
  [...card.querySelectorAll('a.share-btn')].find((a) => a.getAttribute('aria-label') === label);

const copyButton = (card) =>
  [...card.querySelectorAll('button.share-btn')].find(
    (b) => ['リンクをコピー', 'コピーしました'].includes(b.getAttribute('aria-label'))
  );

const YT_REC = rec(
  'yt-1',
  YT_FEED_ID,
  'ヨルシカ - 茜（OFFICIAL VIDEO）',
  'https://www.youtube.com/watch?v=abc123XYZ',
  '2026-11-15T00:00:00.000Z'
);
const POD_REC = rec(
  'pod-1',
  POD_FEED_ID,
  'ポッドキャストの回',
  'https://example.com/episodes/1',
  '2026-11-14T00:00:00.000Z'
);

beforeEach(async () => {
  errors = [];
  document.body.innerHTML = '';
  const rows = await loadLocalArticles();
  await deleteLocalArticles(rows.map((r) => r.id));
  localStorage.clear();
  localStorage.setItem(
    'reader:session:v1',
    JSON.stringify({ token: 'tok', role: 'owner', expiresAt: null })
  );
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.scrollTo = function () {};
  writeText = vi.fn(async () => {});
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  vi.stubGlobal('Audio', FakeAudio);
  vi.clearAllMocks();
});

afterEach(() => {
  if (app) app.unmount();
  app = null;
  el = null;
  vi.unstubAllGlobals();
});

describe('共有ボタンの表示と URL', () => {
  it('全記事に X / Facebook / Threads の共有リンクとコピーボタンが出る', async () => {
    await mountApp([YT_REC, POD_REC]);

    for (const [record, title] of [[YT_REC, YT_REC.title], [POD_REC, POD_REC.title]]) {
      const card = cardByTitle(title);
      expect(card, title).toBeTruthy();

      const x = shareAnchor(card, 'Xで共有');
      expect(x, 'X').toBeTruthy();
      expect(x.getAttribute('href')).toBe(buildXShareUrl(record.title, record.link));
      expect(x.getAttribute('target')).toBe('_blank');
      expect(x.getAttribute('rel')).toContain('noopener');

      const fb = shareAnchor(card, 'Facebookで共有');
      expect(fb, 'Facebook').toBeTruthy();
      expect(fb.getAttribute('href')).toBe(buildFacebookShareUrl(record.link));
      expect(fb.getAttribute('target')).toBe('_blank');

      const th = shareAnchor(card, 'Threadsで共有');
      expect(th, 'Threads').toBeTruthy();
      expect(th.getAttribute('href')).toBe(buildThreadsShareUrl(record.title, record.link));
      expect(th.getAttribute('target')).toBe('_blank');

      expect(copyButton(card), 'コピーボタン').toBeTruthy();
    }
  });
});

describe('リンクコピー', () => {
  it('元リンクをコピーし、押した記事のボタンだけフィードバック表示になる', async () => {
    await mountApp([YT_REC, POD_REC]);

    const ytCard = cardByTitle(YT_REC.title);
    const btn = copyButton(ytCard);
    btn.click();
    await flushUntil(() => btn.getAttribute('aria-label') === 'コピーしました');

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(YT_REC.link);
    expect(btn.classList.contains('is-copied')).toBe(true);

    const podBtn = copyButton(cardByTitle(POD_REC.title));
    expect(podBtn.getAttribute('aria-label')).toBe('リンクをコピー');
    expect(podBtn.classList.contains('is-copied')).toBe(false);
  });
});

describe('読み取り専用セッション', () => {
  it('共有リンクで開いた側でも共有ボタンが出る', async () => {
    localStorage.setItem(
      'reader:session:v1',
      JSON.stringify({ token: 'tok-readonly', role: 'readonly', expiresAt: null })
    );
    await mountApp([POD_REC]);

    const card = cardByTitle(POD_REC.title);
    expect(shareAnchor(card, 'Xで共有')).toBeTruthy();
    expect(shareAnchor(card, 'Facebookで共有')).toBeTruthy();
    expect(shareAnchor(card, 'Threadsで共有')).toBeTruthy();
    expect(copyButton(card)).toBeTruthy();
  });
});
