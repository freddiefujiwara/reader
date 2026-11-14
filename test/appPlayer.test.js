// プレイヤー (App.vue) のコンポーネントテスト。API と取得経路だけを
// モックし、記事は IndexedDB (fake-indexeddb) へ種まきして実際の
// App をマウントする。Audio 要素は jsdom では再生できないため、
// イベントを発火できる最小のスタブに差し替える。
// 固定したい振る舞い: 既定モード (連続再生) でエピソードが終わると
// 同じフィードの次へ進み、末尾で止まること。スキップがアイコン化
// されていること。モード切替が blog と同じ名前で効き、保存されること。
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
  isPrivate: false,
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
  deleteFeed: vi.fn(async () => ({ ok: true })),
  exchangeSession: vi.fn(async () => ({ ok: true })),
  exchangeShare: vi.fn(async () => ({ ok: true })),
  listArticles: vi.fn(async () => ({ ok: true, feeds: [FEED], articles: [] })),
  listFeeds: vi.fn(async () => ({ ok: true, feeds: [FEED] })),
  reorderFeeds: vi.fn(async () => ({ ok: true })),
  saveFeed: vi.fn(async () => ({ ok: true, feed: FEED })),
}));

vi.mock('../src/lib/feedFetch.js', () => ({
  fetchAllFeeds: vi.fn(async () => []),
  fetchFeedXml: vi.fn(async () => ''),
}));

// ローカルでは API_URL はプレースホルダ (CI がビルド時に置換) で
// 空になり、起動処理が止まってしまうため、値が入った形に差し替える。
vi.mock('../src/config.js', () => ({
  API_URL: 'https://example.com/exec',
  GOOGLE_CLIENT_ID: 'test-client-id',
}));

import App from '../src/App.vue';
import { saveLocalFeeds, putLocalArticles } from '../src/lib/localDb.js';

// jsdom の HTMLMediaElement は再生を実装しないため、App が使う
// 面だけを持ち、'ended' などをテストから発火できるスタブにする。
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

const latestAudio = () => audioInstances[audioInstances.length - 1];

async function seed() {
  await saveLocalFeeds([FEED]);
  await putLocalArticles([{ ...EP1 }, { ...EP2 }]);
}

async function mountPlayer() {
  await seed();
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
  await flush();
  expect(el.querySelectorAll('.article-card').length, '記事カードが2件出る').toBe(2);
}

async function startCard(idx) {
  const card = el.querySelectorAll('.article-card')[idx];
  card.querySelector('.play-btn').click();
  await flush();
  return el.querySelector('.player-bar');
}

async function fireEnded() {
  const audio = latestAudio();
  audio.ended = true;
  audio.paused = true;
  audio.dispatchEvent(new window.Event('ended'));
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

describe('プレイヤーの自動送り (連続再生)', () => {
  it('エピソードが終わると同じフィードの次へ進み、既読になり、末尾で止まる', async () => {
    await mountPlayer();
    const bar = await startCard(0);
    expect(errors).toEqual([]);
    expect(bar, 'プレイヤーバーが出る').toBeTruthy();
    expect(bar.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(latestAudio().src).toBe('https://example.com/ep1.mp3');

    await fireEnded();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(latestAudio().src).toBe('https://example.com/ep2.mp3');
    // 聴き終えた1件目は既読表示になる。
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(true);

    await fireEnded();
    // 末尾なので進まず、同じエピソードのまま止まる。
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(latestAudio().src).toBe('https://example.com/ep2.mp3');
  });
});

describe('プレイヤーバーのボタン', () => {
  it('スキップはアイコン (数字入り) で、テキストではない', async () => {
    await mountPlayer();
    const bar = await startCard(0);
    const back = bar.querySelector('button[aria-label="15秒戻る"]');
    const fwd = bar.querySelector('button[aria-label="30秒進む"]');
    expect(back.querySelector('svg'), '巻き戻しアイコン').toBeTruthy();
    expect(fwd.querySelector('svg'), '早送りアイコン').toBeTruthy();
    expect(back.textContent).toContain('15');
    expect(fwd.textContent).toContain('30');
    expect(bar.textContent).not.toContain('−15秒');
    expect(bar.textContent).not.toContain('+30秒');
  });

  it('モード切替は既定でオフ、リピートは循環し、切替が保存される', async () => {
    await mountPlayer();
    const bar = await startCard(0);
    const repeatBtn = () => bar.querySelector('button[aria-label^="リピート"]');
    const shuffleBtn = () => bar.querySelector('button[aria-label^="ランダム"]');
    expect(repeatBtn().getAttribute('aria-label')).toBe('リピート：なし');
    expect(shuffleBtn().getAttribute('aria-label')).toBe('ランダム：オフ');
    expect(shuffleBtn().getAttribute('aria-pressed')).toBe('false');

    repeatBtn().click();
    await flush();
    expect(repeatBtn().getAttribute('aria-label')).toBe('リピート：全曲');
    expect(bar.querySelector('.player-badge')).toBeNull();

    repeatBtn().click();
    await flush();
    expect(repeatBtn().getAttribute('aria-label')).toBe('リピート：1曲');
    expect(bar.querySelector('.player-badge')?.textContent).toBe('1');

    shuffleBtn().click();
    await flush();
    expect(shuffleBtn().getAttribute('aria-label')).toBe('ランダム：オン');
    expect(shuffleBtn().getAttribute('aria-pressed')).toBe('true');

    expect(localStorage.getItem('reader:player-mode:v1')).toBe('{"shuffle":true,"repeat":"one"}');
    expect(errors).toEqual([]);
  });
});

// 任意のレコードで種まきしてマウントする (mountPlayer の差し替え版)。
async function mountWithRecords(records) {
  await saveLocalFeeds([FEED]);
  await putLocalArticles(records);
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
  await flush();
  expect(el.querySelectorAll('.article-card').length, '記事カードが2件出る').toBe(2);
}

describe('合計時間の表示 (YouTube 音声の長さ補正)', () => {
  it('要素が2倍の長さを報告しても、モデル実測前から合計時間は実尺で出る', async () => {
    await mountPlayer();
    await startCard(0); // EP1 の実尺は duration_sec = 1800
    const audio = latestAudio();
    audio.duration = 3600; // 要素は実尺の2倍を報告する
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    await flush();
    // モデル (direct / scaled) はまだ実測できていないが、合計時間は
    // 実尺の 30:00 で出る (従来は要素の報告どおり 1:00:00 だった)。
    expect(el.querySelector('.player-total').textContent).toBe('30:00');
    expect(errors).toEqual([]);
  });

  it('要素の報告が実尺と一致すれば、そのまま要素の値を出す', async () => {
    await mountPlayer();
    await startCard(0);
    const audio = latestAudio();
    audio.duration = 1800;
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    await flush();
    expect(el.querySelector('.player-total').textContent).toBe('30:00');
    expect(errors).toEqual([]);
  });

  it('実尺が不明な記事では、要素の報告をそのまま出す', async () => {
    await mountWithRecords([{ ...EP1, duration_sec: null }, { ...EP2 }]);
    await startCard(0);
    const audio = latestAudio();
    audio.duration = 3600;
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    await flush();
    expect(el.querySelector('.player-total').textContent).toBe('1:00:00');
    expect(errors).toEqual([]);
  });
});

describe('エピソード開始時の記事の引き直し', () => {
  it('キュー固定後に更新で埋まった durationSec を、自動送りの開始時に拾う', async () => {
    // EP2 の実尺がまだ不明な状態で種まきし、EP1 から再生を始める
    // (キューはこの時点の記事オブジェクトで固定される)。
    await mountWithRecords([{ ...EP1 }, { ...EP2, duration_sec: null }]);
    await startCard(0);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');

    // 背景更新で EP2 の実尺が埋まった状態を DB へ入れ、更新を回して
    // state へ反映する。キュー内の EP2 は古い控えのまま残る。
    await putLocalArticles([{ ...EP2, duration_sec: 104 }]);
    await flush();
    el.querySelector('.nav-refresh').click();
    await flush();
    await flush();

    // EP1 が終わると EP2 が始まる。開始時に state から引き直すので、
    // 実尺 104 が効き、要素が2倍 (208) を報告しても合計は 1:44。
    await fireEnded();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    const audio = latestAudio();
    audio.duration = 208;
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    await flush();
    expect(el.querySelector('.player-total').textContent).toBe('1:44');
    expect(errors).toEqual([]);
  });
});

describe('読み込み表示', () => {
  it('読み込み中は再生ボタンが blog と同じ「…」になり、再生可能になるとアイコンへ戻る', async () => {
    await mountPlayer();
    const bar = await startCard(0);
    const playBtn = bar.querySelector('.player-play');
    // loadEpisode で読み込み中になり、ボタンはアイコンの代わりに
    // 文字の「…」を出す (リングスピナーは出さない)。
    expect(playBtn.getAttribute('aria-label')).toBe('読み込み中');
    expect(playBtn.textContent).toContain('…');
    expect(playBtn.querySelector('.player-spinner')).toBeNull();
    expect(playBtn.querySelector('svg')).toBeNull();

    latestAudio().dispatchEvent(new window.Event('canplay'));
    await flush();
    expect(playBtn.getAttribute('aria-label')).toBe('一時停止');
    expect(playBtn.querySelector('svg')).toBeTruthy();
    expect(errors).toEqual([]);
  });
});
