// 要約の「もっと見る」展開 (App.vue) のコンポーネントテスト。
// ハーネスは appStar と同じ (API と取得経路だけモックし、記事は
// IndexedDB へ種まきして実際の App をマウントする)。
// 固定したい振る舞い:
// - 省略されている (line-clamp で切れている) 要約にだけボタンが出る。
//   省略の判定は描画後の scrollHeight / clientHeight の比較で行うため、
//   jsdom では各要約要素に高さを差し込んでから resize で測り直させる。
// - 押すと展開 (expanded クラス) してボタンが「閉じる」に変わり、
//   再度押すと元の省略表示に戻る。複数カードは独立に開閉できる。
// - 展開ボタンのクリックは記事オープン (既読化) を引き起こさない。
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, nextTick } from 'vue';

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
const FEEDS = [POD_FEED];

const LONG_SUMMARY = 'あ'.repeat(300);
const LONG_SUMMARY_2 = 'い'.repeat(300);
const SHORT_SUMMARY = '短い要約です。';

const rec = (id, title, published_at, summary) => ({
  id,
  feed_id: POD_FEED_ID,
  title,
  link: `https://example.com/${id}`,
  published_at,
  fetched_at: '2026-11-15T00:00:00.000Z',
  summary,
  author: '',
  audio_url: '',
  audio_url_at: '',
  audio_stale: false,
  duration_sec: null,
  play_pos: 0,
  is_read: false,
  read_at: '',
  starred: false,
  star_state: '',
});

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
  issueShareLink: vi.fn(async () => ({ ok: true, token: 'dummy-share-token', expiresAt: '2026-12-16T05:47:00.000Z' })),
  revokeShareLink: vi.fn(async () => ({ ok: true })),
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

// jsdom の HTMLMediaElement は再生を実装しないため、App が使う
// 面だけを持つスタブにする (appStar と同じ)。
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

const localRow = async (id) => (await loadLocalArticles()).find((a) => a.id === id);

// 要約要素に「省略されている／されていない」を表す高さを差し込み、
// resize イベントで App に測り直させる。長い要約は scrollHeight が
// clientHeight (3行分) を上回り、短い要約は収まっている状態にする。
function stubSummaryHeights() {
  const setHeights = (title, scrollHeight, clientHeight) => {
    const p = cardByTitle(title).querySelector('.article-summary');
    Object.defineProperty(p, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(p, 'clientHeight', { configurable: true, value: clientHeight });
  };
  setHeights('長い要約の記事', 220, 66);
  setHeights('もう一つの長い記事', 220, 66);
  setHeights('短い要約の記事', 40, 66);
}

async function mountWithSummaries() {
  await mountApp([
    rec('long-1', '長い要約の記事', '2026-11-15T00:00:00.000Z', LONG_SUMMARY),
    rec('long-2', 'もう一つの長い記事', '2026-11-14T00:00:00.000Z', LONG_SUMMARY_2),
    rec('short-1', '短い要約の記事', '2026-11-13T00:00:00.000Z', SHORT_SUMMARY),
  ]);
  stubSummaryHeights();
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
  vi.stubGlobal('Audio', FakeAudio);
  vi.clearAllMocks();
});

afterEach(() => {
  if (app) app.unmount();
  app = null;
  el = null;
  vi.unstubAllGlobals();
});

describe('要約の「もっと見る」ボタン表示', () => {
  it('省略されている要約にだけ「もっと見る」が出て、短い要約には出ない', async () => {
    await mountWithSummaries();

    const longCard = cardByTitle('長い要約の記事');
    const toggle = longCard.querySelector('.summary-toggle');
    expect(toggle, '長い要約には展開ボタン').toBeTruthy();
    expect(toggle.textContent).toBe('もっと見る');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // 要約のテキスト自体は全文が DOM にある (切り詰めは表示側)。
    expect(longCard.querySelector('.article-summary').textContent).toBe(LONG_SUMMARY);

    const shortCard = cardByTitle('短い要約の記事');
    expect(shortCard.querySelector('.summary-toggle'), '短い要約にボタンは出ない').toBeNull();
  });
});

describe('要約の展開と折りたたみ', () => {
  it('押すと展開して「閉じる」に変わり、再度押すと元の省略表示に戻る', async () => {
    await mountWithSummaries();
    const card = cardByTitle('長い要約の記事');
    const summary = card.querySelector('.article-summary');
    expect(summary.classList.contains('expanded')).toBe(false);

    card.querySelector('.summary-toggle').click();
    await flush();
    expect(summary.classList.contains('expanded'), '展開で expanded が付く').toBe(true);
    expect(card.querySelector('.summary-toggle').textContent).toBe('閉じる');
    expect(card.querySelector('.summary-toggle').getAttribute('aria-expanded')).toBe('true');

    card.querySelector('.summary-toggle').click();
    await flush();
    expect(summary.classList.contains('expanded'), '閉じると expanded が外れる').toBe(false);
    expect(card.querySelector('.summary-toggle'), '閉じた後もボタンは残る').toBeTruthy();
    expect(card.querySelector('.summary-toggle').textContent).toBe('もっと見る');
  });

  it('複数カードを独立に開閉できる', async () => {
    await mountWithSummaries();
    const first = cardByTitle('長い要約の記事');
    const second = cardByTitle('もう一つの長い記事');

    first.querySelector('.summary-toggle').click();
    await flush();

    expect(first.querySelector('.article-summary').classList.contains('expanded')).toBe(true);
    expect(second.querySelector('.article-summary').classList.contains('expanded'), '他カードは閉じたまま').toBe(false);
    expect(second.querySelector('.summary-toggle').textContent).toBe('もっと見る');
  });

  it('展開ボタンを押しても記事は既読化されない', async () => {
    await mountWithSummaries();
    const card = cardByTitle('長い要約の記事');

    card.querySelector('.summary-toggle').click();
    await flush();
    card.querySelector('.summary-toggle').click();
    await flush();

    const row = await localRow('long-1');
    expect(row.is_read, 'ローカルの既読状態は変わらない').toBe(false);
    expect(card.classList.contains('is-read'), 'カードにも既読表示は付かない').toBe(false);
  });
});
