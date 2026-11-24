// フィードチップ行の開閉トグル (App.vue) のコンポーネントテスト。
// ハーネスは appSummaryExpand と同じ (API と取得経路だけモックし、
// フィードは IndexedDB へ種まきして実際の App をマウントする)。
// 固定したい振る舞い:
// - PC幅では CSS で2行までに抑えられる前提で、はみ出し (scrollHeight が
//   clientHeight を上回る) を測れたときにだけ「すべて表示」が出る。
//   判定は描画後の測定で行うため、jsdom ではチップ行要素に高さを
//   差し込んでから resize で測り直させる。
// - 押すと展開 (is-collapsed が外れる) して「閉じる」に変わり、
//   再度押すと折りたたみに戻る。
// - チップの顔ぶれが変わる (カテゴリ選択など) と、閉じた状態に戻る。
//   収まる件数ではトグルは出ない。
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, nextTick } from 'vue';

const feed = (id, slug, title, category) => ({
  id,
  title,
  url: `https://example.com/feeds/${slug}`,
  category,
  lastStatus: '200',
  lastError: '',
  lastFetchedAt: '',
  unreadCount: 0,
});

// ID は本番の規則どおり URL の SHA-256 先頭16文字に合わせる
// (サーバー応答の ID は normalizeFeedIds で URL ハッシュへ付け替わるため、
//  違う ID を使うと起動途中でチップの顔ぶれが変わった扱いになり、
//  開閉状態がリセットされる競合が起きる)。
// 「すべて」では8件 (2行に収まらない想定)、カテゴリ「技術」では2件。
const FEEDS = [
  feed('d3d8f1f37b999cf6', 'f1', 'フィード1', '音楽'),
  feed('bb50086cc8477a0d', 'f2', 'フィード2', '音楽'),
  feed('13d7b4613ddd9ef7', 'f3', 'フィード3', '音楽'),
  feed('ce36e18d77007cbd', 'f4', 'フィード4', '音楽'),
  feed('e40258a0e40d3a0e', 'f5', 'フィード5', '音楽'),
  feed('d70fde9f66427c66', 'f6', 'フィード6', '音楽'),
  feed('bc2c97761ff9e0ce', 'f7', 'フィード7', '技術'),
  feed('29675641a83ba56f', 'f8', 'フィード8', '技術'),
];

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
import { loadLocalArticles, saveLocalFeeds, deleteLocalArticles } from '../src/lib/localDb.js';

// jsdom の HTMLMediaElement は再生を実装しないため、App が使う
// 面だけを持つスタブにする (appSummaryExpand と同じ)。
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

const flush = async () => {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();
  }
};

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

async function mountApp() {
  await saveLocalFeeds(FEEDS.map((f) => ({ ...f })));
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
  await flush();
  await flushUntil(() => feedChipsRow() && feedChipsRow().querySelectorAll('.chip').length === FEEDS.length);
  expect(errors).toEqual([]);
}

const feedChipsRow = () => el.querySelector('[aria-label="フィードで絞り込み"]');
const categoryChipsRow = () => el.querySelector('[aria-label="カテゴリで絞り込み"]');
const toggle = () => el.querySelector('.chips-toggle');

// チップ行に「はみ出している／収まっている」を表す高さを差し込み、
// resize イベントで App に測り直させる。抑えたときの clientHeight は
// 2行分の 94、はみ出しはそれを大きく上回る値にする。
function stubChipsHeights(scrollHeight, clientHeight) {
  const row = feedChipsRow();
  Object.defineProperty(row, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(row, 'clientHeight', { configurable: true, value: clientHeight });
}

async function measure() {
  window.dispatchEvent(new window.Event('resize'));
  await flush();
}

beforeEach(async () => {
  errors = [];
  audioInstances.length = 0;
  document.body.innerHTML = '';
  const rows = await loadLocalArticles();
  await deleteLocalArticles(rows.map((r) => r.id));
  localStorage.clear();
  localStorage.setItem(
    'reader:session:v1',
    JSON.stringify({ token: 'tok', role: 'owner', expiresAt: null })
  );
  window.scrollTo = () => {};
  vi.stubGlobal('Audio', FakeAudio);
  vi.clearAllMocks();
});

afterEach(() => {
  if (app) app.unmount();
  app = null;
  el = null;
  vi.unstubAllGlobals();
});

describe('フィードチップ行の開閉トグル', () => {
  it('はみ出すときだけ「すべて表示」が出て、押すと展開・再押下で折りたたみに戻る', async () => {
    await mountApp();
    // 測定前 (高さ未確定) ではトグルは出ない。
    expect(toggle(), '測定前はトグルなし').toBeNull();
    expect(feedChipsRow().classList.contains('is-collapsed')).toBe(true);

    stubChipsHeights(300, 94);
    await measure();
    const btn = toggle();
    expect(btn, 'はみ出すとトグルが出る').toBeTruthy();
    expect(btn.textContent).toBe('すべて表示');
    expect(btn.getAttribute('aria-expanded')).toBe('false');

    btn.click();
    await flush();
    expect(feedChipsRow().classList.contains('is-collapsed'), '展開で is-collapsed が外れる').toBe(false);
    expect(toggle().textContent).toBe('閉じる');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');

    toggle().click();
    await flush();
    expect(feedChipsRow().classList.contains('is-collapsed'), '閉じると is-collapsed が戻る').toBe(true);
    expect(toggle(), '閉じた後もトグルは残る').toBeTruthy();
    expect(toggle().textContent).toBe('すべて表示');
  });

  it('2行に収まるときはトグルが出ない', async () => {
    await mountApp();
    stubChipsHeights(94, 94);
    await measure();
    expect(toggle(), '収まるときはトグルなし').toBeNull();
  });

  it('カテゴリを選ぶと閉じた状態に戻り、収まる件数ではトグルが消える', async () => {
    await mountApp();
    stubChipsHeights(300, 94);
    await measure();
    toggle().click();
    await flush();
    expect(feedChipsRow().classList.contains('is-collapsed')).toBe(false);

    const tech = [...categoryChipsRow().querySelectorAll('.chip')].find(
      (c) => c.textContent === '技術'
    );
    tech.click();
    // 技術カテゴリは2件で収まる高さに差し替えてから、測定を通す。
    stubChipsHeights(40, 94);
    await flush();

    expect(feedChipsRow().querySelectorAll('.chip').length).toBe(2);
    expect(feedChipsRow().classList.contains('is-collapsed'), '顔ぶれが変わると閉じた状態に戻る').toBe(true);
    expect(toggle(), '収まる件数ではトグルは出ない').toBeNull();
  });
});
