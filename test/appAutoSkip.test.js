// 再生できないエピソードの自動スキップ (App.vue) のコンポーネント
// テスト。API と取得経路だけをモックし、記事は IndexedDB
// (fake-indexeddb) へ種まきして実際の App をマウントする。
// 固定したい振る舞い:
// - error イベント / play() の拒否 / 再生中のストールで、キューの
//   次へ自動で進む (失敗したエピソードは既読にならない)。
// - 単曲リピート中でも壊れたエピソードは繰り返さない。
// - 次が無い・連続失敗が上限に達したら、その場で停止する。
// - play() の AbortError (中断) や初回読み込み中は失敗とみなさない。
// - stale な保持URLが死んでいて次がある場合は、閉じる代わりに
//   次へ進む (音声の取り消し自体は PR #63 どおり行う)。
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

const rec = (id, title, published_at, audio_url, extra = {}) => ({
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
  ...extra,
});
const EP1 = rec('ep-1', 'エピソード1', '2026-11-14T00:00:00.000Z', 'https://example.com/ep1.mp3');
const EP2 = rec('ep-2', 'エピソード2', '2026-11-13T00:00:00.000Z', 'https://example.com/ep2.mp3');
const KEPT_URL = 'https://example.com/kept.mp3';

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
import { fetchOneFeed } from '../src/lib/feedFetch.js';
import { articleId } from '../src/lib/articleId.js';
import { loadLocalArticles, saveLocalFeeds, putLocalArticles, deleteLocalArticles } from '../src/lib/localDb.js';

// src ごとに play() を拒否させる表 (値域はエラーの name)。
// 拒否する場合は再生が始まらないので 'play' も発火させない。
const playRejections = new Map();
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
    const rejectName = playRejections.get(this.src);
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

const latestAudio = () => audioInstances[audioInstances.length - 1];

// logEvents へ渡ったイベントをすべて平らに集める。
const sentEvents = () => logEvents.mock.calls.flatMap((c) => c[1]);

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
  // IndexedDB はファイル内のテストで共有されるため、前のテストの
  // 種が残っていたら消してからまく (件数と並びを安定させる)。
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

beforeEach(() => {
  errors = [];
  audioInstances.length = 0;
  playRejections.clear();
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

describe('error イベントでの自動スキップ', () => {
  it('error で次へ進み、失敗したエピソードは既読にならず、末尾ではその場で止まる', async () => {
    await mountWith([EP1, EP2]);
    await startCard(0);
    const audio = latestAudio();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');

    audio.dispatchEvent(new window.Event('error'));
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(audio.src).toBe('https://example.com/ep2.mp3');
    // 聴き終えたわけではないので、失敗した1件目は既読にならない。
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(false);
    expect(audio.paused).toBe(false);

    // 末尾で失敗したら、次が無いのでその場で停止する
    // (プレイヤーは閉じず、エピソードを表示したまま止める)。
    audio.dispatchEvent(new window.Event('error'));
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-bar'), 'プレイヤーは残る').toBeTruthy();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(audio.paused).toBe(true);
  });

  it('単曲リピート中でも、失敗したエピソードは繰り返さず次へ進む', async () => {
    await mountWith([EP1, EP2]);
    const bar = await startCard(0);
    const repeatBtn = () => bar.querySelector('button[aria-label^="リピート"]');
    repeatBtn().click();
    await flush();
    repeatBtn().click();
    await flush();
    expect(repeatBtn().getAttribute('aria-label')).toBe('リピート：1曲');

    latestAudio().dispatchEvent(new window.Event('error'));
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(latestAudio().src).toBe('https://example.com/ep2.mp3');
  });

  it('全体繰り返しでも、連続失敗が上限 (キューの1巡分) に達したら止まる', async () => {
    await mountWith([EP1, EP2]);
    const bar = await startCard(0);
    const repeatBtn = () => bar.querySelector('button[aria-label^="リピート"]');
    repeatBtn().click();
    await flush();
    expect(repeatBtn().getAttribute('aria-label')).toBe('リピート：全曲');
    const audio = latestAudio();

    audio.dispatchEvent(new window.Event('error'));
    await flush();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    audio.dispatchEvent(new window.Event('error'));
    await flush();
    // 全体繰り返しなので先頭へ戻る (連続失敗2回目)。
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    audio.dispatchEvent(new window.Event('error'));
    await flush();
    // 3回目は上限 (2件のキューを1巡) を超えるので、その場で止まる。
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(audio.paused).toBe(true);
  });
});

describe('play() の拒否での自動スキップ', () => {
  it('NotSupportedError で次へ進む', async () => {
    playRejections.set('https://example.com/ep1.mp3', 'NotSupportedError');
    await mountWith([EP1, EP2]);
    await startCard(0);
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(latestAudio().src).toBe('https://example.com/ep2.mp3');
    expect(latestAudio().paused).toBe(false);
  });

  it('AbortError (pause や差し替えによる中断) では進まない', async () => {
    playRejections.set('https://example.com/ep1.mp3', 'AbortError');
    await mountWith([EP1, EP2]);
    await startCard(0);
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(latestAudio().src).toBe('https://example.com/ep1.mp3');
  });
});

// 偽タイマーを入れる前に、本物の setTimeout を控えておく (ポンプ用)。
const realSetTimeout = globalThis.setTimeout;

describe('ストール検知での自動スキップ', () => {
  // 終端チェックのタイマー (500ms) に相乗りする検知を、偽タイマーと
  // performance.now の操作で再現する。時刻の正は performance.now
  // 側に寄せ、タイマーは tick を起こすためだけに進める。
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

  // タイマーを1 tick 分進めて、その時点の performance.now を nowVal に合わせる。
  async function tick(flushFake, setNow) {
    setNow();
    await vi.advanceTimersByTimeAsync(500);
    await flushFake();
  }

  it('再生中なのに位置が10秒進まなければ次へ進み、進んでいれば進まない', async () => {
    vi.useFakeTimers();
    let nowVal = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => nowVal);
    try {
      const flushFake = await mountFake([EP1, EP2]);
      el.querySelectorAll('.article-card')[0].querySelector('.play-btn').click();
      await flushFake();
      const audio = latestAudio();
      audio.currentTime = 30;
      audio.dispatchEvent(new window.Event('playing'));
      // 基準作りの tick (位置30・時刻0)。
      await tick(flushFake, () => { nowVal = 0; });
      expect(el.querySelector('.player-title').textContent).toBe('エピソード1');

      // 位置が進んでいる間は、合計45秒経っても送らない。
      await tick(flushFake, () => { nowVal = 15_000; audio.currentTime = 45; });
      await tick(flushFake, () => { nowVal = 30_000; audio.currentTime = 60; });
      await tick(flushFake, () => { nowVal = 45_000; audio.currentTime = 75; });
      expect(el.querySelector('.player-title').textContent).toBe('エピソード1');

      // ここから位置が止まる。9秒ではまだ送らない。
      await tick(flushFake, () => { nowVal = 54_000; });
      expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
      // 10秒を超えたら次へ進む。
      await tick(flushFake, () => { nowVal = 55_500; });
      expect(errors).toEqual([]);
      expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
      // 二重バッファ: 'playing' の時点で待機側へ先読みされていた
      // 次曲へ、役割交代で切り替わって再生される (旧要素は待機側
      // になり、src は空に戻る)。
      expect(latestAudio().src).toBe('https://example.com/ep2.mp3');
      expect(latestAudio().paused).toBe(false);
      expect(audio.src).toBe('');
    } finally {
      nowSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('ストール検知が発動したら、止まった位置つきで stall が送られる', async () => {
    vi.useFakeTimers();
    let nowVal = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => nowVal);
    try {
      const flushFake = await mountFake([EP1, EP2]);
      el.querySelectorAll('.article-card')[0].querySelector('.play-btn').click();
      await flushFake();
      const audio = latestAudio();
      audio.currentTime = 30;
      audio.dispatchEvent(new window.Event('playing'));
      // 基準作りの tick (位置30・時刻0)。
      await tick(flushFake, () => { nowVal = 0; });
      // 位置が30のまま10秒を超えたら検知が発動し、次へ進む。
      await tick(flushFake, () => { nowVal = 10_500; });
      expect(errors).toEqual([]);
      expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
      // 診断: 発動した検知が、止まった曲と位置 (30秒) で残る。
      expect(sentEvents().filter((e) => e.type === 'stall')).toEqual([
        expect.objectContaining({
          feed_id: FEED_ID,
          article_id: 'ep-1',
          article_title: 'エピソード1',
          seconds: 30,
        }),
      ]);
      // 失敗時の送りは「曲の終了」ではないので、遷移の内訳
      // (advance_*) は残らない。
      expect(sentEvents().filter((e) => e.type.startsWith('advance_'))).toEqual([]);
    } finally {
      nowSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('初回読み込み中 (まだ再生が始まっていない) はストールと判定しない', async () => {
    vi.useFakeTimers();
    let nowVal = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => nowVal);
    try {
      const flushFake = await mountFake([EP1, EP2]);
      el.querySelectorAll('.article-card')[0].querySelector('.play-btn').click();
      await flushFake();
      const audio = latestAudio();
      // 'playing' を送らない = まだ初回読み込み中。位置が止まった
      // まま30秒経っても送らない。
      await tick(flushFake, () => { nowVal = 0; });
      await tick(flushFake, () => { nowVal = 30_000; });
      expect(el.querySelector('.player-title').textContent).toBe('エピソード1');

      // 再生が始まってからは、止まれば検知の対象になる。
      audio.currentTime = 10;
      audio.dispatchEvent(new window.Event('playing'));
      await tick(flushFake, () => { nowVal = 30_000; });
      await tick(flushFake, () => { nowVal = 39_500; });
      expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
      await tick(flushFake, () => { nowVal = 40_500; });
      expect(errors).toEqual([]);
      expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    } finally {
      nowSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('stale な保持URLの失敗 (PR #63 との関係)', () => {
  it('次がある場合は閉じる代わりに次へ進み、音声は取り消される', async () => {
    const staleId = await articleId(FEED_ID, 'vid-autoskip-stale');
    const stale = rec(staleId, '古いエピソード', '2026-11-14T00:00:00.000Z', KEPT_URL, {
      link: 'https://example.com/vid-autoskip-stale',
      audio_url_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      audio_stale: true,
    });
    fetchOneFeed.mockResolvedValue({ feed: FEED, ok: false, entries: [], error: new Error('network') });
    await mountWith([stale, EP2]);
    el.querySelectorAll('.article-card')[0].querySelector('.play-btn').click();
    await flushUntil(() => latestAudio() && latestAudio().src === KEPT_URL);
    expect(el.querySelector('.player-bar'), 'プレイヤーが出ている').toBeTruthy();

    latestAudio().dispatchEvent(new window.Event('error'));
    // 閉じるのではなく、次のエピソードへ進む。
    await flushUntil(() => el.querySelector('.player-title')?.textContent === 'エピソード2');
    expect(errors).toEqual([]);
    expect(latestAudio().src).toBe('https://example.com/ep2.mp3');
    // 死んだ保持URLは従来どおり取り消される。
    const row = (await loadLocalArticles()).find((a) => a.id === staleId);
    expect(row.audio_url).toBe('');
    expect(row.audio_stale).toBe(false);
  });
});
