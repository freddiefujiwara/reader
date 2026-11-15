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
import { loadLocalArticles, saveLocalFeeds, putLocalArticles } from '../src/lib/localDb.js';

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

describe('再開位置の保存 (終端間際は保存しない)', () => {
  it('終端間際で止めても再開位置は 0 になり、DB の既存値も消える', async () => {
    // 前回分の再開位置 500 が残っている状態から始める。
    await mountWithRecords([{ ...EP1, play_pos: 500 }, { ...EP2 }]);
    await startCard(0);
    const audio = latestAudio();
    audio.duration = 1800; // EP1 の実尺どおり
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    await flush();
    expect(audio.currentTime).toBe(500);

    // 終端まで残り3秒の位置で一時停止 → 保存されるのは 0。
    audio.currentTime = 1797;
    audio.pause();
    await flush();
    const saved = (await loadLocalArticles()).find((r) => r.id === 'ep-1');
    expect(saved.play_pos).toBe(0);
    expect(errors).toEqual([]);
  });

  it('中盤で止めれば、その位置が従来どおり保存される', async () => {
    await mountPlayer();
    await startCard(0);
    const audio = latestAudio();
    audio.duration = 1800;
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    await flush();

    audio.currentTime = 900;
    audio.pause();
    await flush();
    const saved = (await loadLocalArticles()).find((r) => r.id === 'ep-1');
    expect(saved.play_pos).toBe(900);
    expect(errors).toEqual([]);
  });
});

describe('表示位置ベースの終了判定 (実測モデルの要否)', () => {
  const ytRec = (base) => ({ ...base, duration_sec: 104 });

  it('learned (端末保存) の流用だけでは、表示位置が終端に達しても終了しない', async () => {
    // 前回分のモデルが端末に残っている状態。
    localStorage.setItem('reader:player-timemodel:v1', 'scaled');
    await mountWithRecords([ytRec(EP1), ytRec(EP2)]);
    await startCard(0);
    const audio = latestAudio();
    audio.duration = 208; // 要素は実尺 104 の2倍を報告する
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    await flush();

    // 表示位置は終端 (103.8 / 104) に達するが、この曲では実測して
    // いないので終了フローは走らない (timeupdate 1回では実測の
    // 窓が閉じないため、モデルは未確定のまま)。
    audio.currentTime = 207.6;
    audio.dispatchEvent(new window.Event('timeupdate'));
    await flush();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(false);
    expect(errors).toEqual([]);
  });

  it('実測で確定したら終了フローが走り、前曲の再開位置は 0 のまま', async () => {
    await mountWithRecords([ytRec(EP1), ytRec(EP2)]);
    await startCard(0);
    const audio = latestAudio();
    audio.duration = 208;
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    await flush();

    // performance.now を操作して実測の窓 (3秒強) を作る: 要素時間が
    // 10 進む → 'scaled' と分類され、この曲のモデルが確定する。
    let nowVal = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => nowVal);
    try {
      audio.currentTime = 0;
      audio.dispatchEvent(new window.Event('timeupdate'));
      nowVal = 3100;
      audio.currentTime = 10;
      audio.dispatchEvent(new window.Event('timeupdate'));
      await flush();

      // 表示位置が終端に達したら終了フローが走り、次へ進む。
      // 'ended' イベント経由ではないため audio.ended は立っていない。
      audio.currentTime = 207.6;
      audio.dispatchEvent(new window.Event('timeupdate'));
      await flush();
    } finally {
      nowSpy.mockRestore();
    }
    expect(audio.ended).toBe(false);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(true);
    // 終了処理でクリアした前曲の位置が、次曲ロード冒頭の保存で
    // 末尾位置に書き戻されていないこと。
    const saved = (await loadLocalArticles()).find((r) => r.id === 'ep-1');
    expect(saved.play_pos).toBe(0);
    expect(errors).toEqual([]);
  });

  it('終了済みの曲をシークで戻してから保存が走っても、位置は書き戻されない', async () => {
    await mountWithRecords([ytRec(EP1), ytRec(EP2)]);
    await startCard(1); // 末尾の EP2 から始める (終わっても次は無い)
    const audio = latestAudio();
    audio.duration = 208;
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    await flush();

    let nowVal = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => nowVal);
    try {
      audio.currentTime = 0;
      audio.dispatchEvent(new window.Event('timeupdate'));
      nowVal = 3100;
      audio.currentTime = 10;
      audio.dispatchEvent(new window.Event('timeupdate'));
      await flush();
      // 実測確定後に終端へ到達 → 終了フロー (既読化・位置クリア)。
      audio.currentTime = 207.6;
      audio.dispatchEvent(new window.Event('timeupdate'));
      await flush();
    } finally {
      nowSpy.mockRestore();
    }
    expect(el.querySelectorAll('.article-card')[1].classList.contains('is-read')).toBe(true);
    expect((await loadLocalArticles()).find((r) => r.id === 'ep-2').play_pos).toBe(0);

    // 終了後にシークで中盤 (表示位置 50) へ戻し、画面を離れる
    // (visibilitychange の保存が走る)。終了済みの曲なので、位置は
    // 書き戻されず 0 のままのはず。
    audio.currentTime = 100;
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      document.dispatchEvent(new window.Event('visibilitychange'));
      await flush();
    } finally {
      delete document.visibilityState;
    }
    expect((await loadLocalArticles()).find((r) => r.id === 'ep-2').play_pos).toBe(0);
    expect(errors).toEqual([]);
  });
});

// 偽タイマーを入れる前に、本物の setTimeout を控えておく (ポンプ用)。
const realSetTimeout = globalThis.setTimeout;

describe('終端停滞ウォッチドッグ (ended が来ない終端の検出)', () => {
  // ウォッチドッグはインターバル駆動で、終端では timeupdate 自体が
  // 止まるのが前提のため、この一群だけ偽タイマーで時間を進める。
  // 実タイマー前提の flush は使わず、advanceTimersByTimeAsync で
  // タイマーと非同期処理をまとめて進める。IndexedDB の内部
  // スケジューリングは偽タイマー側へ寄るため、0ms ではなく少しずつ
  // 進めるポンプでないとトランザクションが完了しない (実測)。
  const flushFake = async () => {
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(10);
      await new Promise((r) => realSetTimeout(r, 1));
      await nextTick();
    }
  };

  async function mountFake() {
    let seeded = false;
    const seeding = seed().then(() => { seeded = true; });
    for (let i = 0; i < 50 && !seeded; i += 1) await flushFake();
    await seeding;
    el = document.createElement('div');
    document.body.appendChild(el);
    app = createApp(App);
    app.config.errorHandler = (err) => { errors.push(err); };
    app.mount(el);
    for (let i = 0; i < 50 && el.querySelectorAll('.article-card').length < 2; i += 1) {
      await flushFake();
    }
    expect(el.querySelectorAll('.article-card').length, '記事カードが2件出る').toBe(2);
  }

  async function startFake(idx) {
    const card = el.querySelectorAll('.article-card')[idx];
    card.querySelector('.play-btn').click();
    await flushFake();
    return el.querySelector('.player-bar');
  }

  // 終端 (実尺 1800 秒) の手前まで進めて、表示位置を同期する。
  async function parkAt(audio, pos) {
    audio.duration = 1800;
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    audio.currentTime = pos;
    audio.dispatchEvent(new window.Event('timeupdate'));
    await flushFake();
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('終端付近で currentTime が止まったままなら、ended が来なくても次へ進む', async () => {
    await mountFake();
    await startFake(0);
    const audio = latestAudio();
    await parkAt(audio, 1799.5);
    expect(audio.ended).toBe(false);

    // ここから currentTime は止まったまま (iOS で 'ended' が来ない
    // 状態)。監視間隔1秒・停滞判定1秒なので、最初の監視 (起点の
    // 記録) だけでは進まず、次の監視で検出して終了フローへ進める
    // (終端到達から約1〜2秒で次へ進む)。
    await vi.advanceTimersByTimeAsync(1200);
    await flushFake();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    await vi.advanceTimersByTimeAsync(2000);
    await flushFake();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('終端の残り3秒付近で止まったままでも、次へ進む', async () => {
    await mountFake();
    await startFake(0);
    const audio = latestAudio();
    await parkAt(audio, 1797);

    // 終端窓 (残り5秒) の内側だが、従来の窓 (残り1秒) より手前で
    // 駐留するケース。最初の監視 (起点の記録) だけでは進まず、
    // 次の監視で検出する (駐留から約2秒で次へ進む)。
    await vi.advanceTimersByTimeAsync(1200);
    await flushFake();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    await vi.advanceTimersByTimeAsync(2000);
    await flushFake();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('終端付近で微小な前進 (tick あたり 0.05 秒未満) が続いても、次へ進む', async () => {
    await mountFake();
    await startFake(0);
    const audio = latestAudio();
    await parkAt(audio, 1799.5);

    // 終端で要素の報告値がわずかに前にずり続けるケース。tick
    // ごとの前進が下限 (0.05 秒) 未満なら「前進していない」と
    // みなすため、累積で下限を超えても数え直しにはならない。
    for (let i = 0; i < 4; i += 1) {
      if (el.querySelector('.player-title').textContent === 'エピソード2') break;
      audio.currentTime = Math.min(audio.currentTime + 0.03, 1799.95);
      audio.dispatchEvent(new window.Event('timeupdate'));
      await vi.advanceTimersByTimeAsync(1000);
    }
    await flushFake();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('終端で要素が無言で paused になっても (isPlaying は true のまま)、次へ進む', async () => {
    await mountFake();
    await startFake(0);
    const audio = latestAudio();
    await parkAt(audio, 1799.5);

    // iOS が終端で 'ended' も 'pause' も発火しないまま要素を
    // paused にするケース。'pause' イベントは来ないので、アプリ
    // 側の isPlaying は true のまま残る (画面は再生中表示)。要素
    // の paused を見て停滞を数えないと、この状態では停滞時間が
    // 一切貯まらず発火しなかった。
    audio.paused = true;
    await vi.advanceTimersByTimeAsync(1200);
    await flushFake();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    await vi.advanceTimersByTimeAsync(2000);
    await flushFake();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('最終5秒を通常速度で再生中は、終了フローは走らない', async () => {
    await mountFake();
    await startFake(0);
    const audio = latestAudio();
    await parkAt(audio, 1795.5);

    // 終端窓 (残り5秒) の内側を、監視間隔 (1秒) のたびに約1秒
    // ずつ前進する通常再生。前進量が下限以上なので停滞とは
    // 数えず、終端付近にいても誤って発火しない。
    for (let i = 0; i < 4; i += 1) {
      audio.currentTime = 1795.5 + (i + 1) * 1.0;
      audio.dispatchEvent(new window.Event('timeupdate'));
      await vi.advanceTimersByTimeAsync(1000);
    }
    await flushFake();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(false);
    expect(errors).toEqual([]);
  });

  it('曲の途中で currentTime が止まっても (ネットワーク停滞)、終了フローは走らない', async () => {
    await mountFake();
    await startFake(0);
    const audio = latestAudio();
    await parkAt(audio, 900);

    await vi.advanceTimersByTimeAsync(15_000);
    await flushFake();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(false);
    expect(errors).toEqual([]);
  });

  it('終端付近でも currentTime が進み続けていれば、終了フローは走らない', async () => {
    await mountFake();
    await startFake(0);
    const audio = latestAudio();
    await parkAt(audio, 1799.0);

    // 監視間隔 (1秒) のたびに少しずつ進み続ける。終端付近にいても、
    // 進んでいる間は停滞として数えない。
    for (let i = 0; i < 5; i += 1) {
      audio.currentTime = Math.min(1799.0 + 0.18 * (i + 1), 1799.95);
      audio.dispatchEvent(new window.Event('timeupdate'));
      await vi.advanceTimersByTimeAsync(1000);
    }
    await flushFake();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(false);
    expect(errors).toEqual([]);
  });

  it('終端付近でも一時停止中は終了フローは走らない', async () => {
    await mountFake();
    await startFake(0);
    const audio = latestAudio();
    await parkAt(audio, 1799.5);

    audio.pause();
    await flushFake();
    await vi.advanceTimersByTimeAsync(15_000);
    await flushFake();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(false);
    expect(errors).toEqual([]);
  });
});

describe('次の曲の先読み', () => {
  // 先読みは本体とは別の2つ目の要素で温める。要素は必要になる
  // まで作られないので、作られたかどうかはインスタンス数で見る。
  const preloadInstance = () => audioInstances[audioInstances.length - 1];

  async function parkNearEnd(audio, pos) {
    audio.duration = 1800;
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    audio.currentTime = pos;
    audio.dispatchEvent(new window.Event('timeupdate'));
    await flush();
  }

  it('残り60秒以下になると次の曲を先読みし、それより前はしない', async () => {
    await mountPlayer();
    await startCard(0);
    const audio = latestAudio();
    expect(audioInstances.length).toBe(1);

    // 残り100秒: まだ先読みしない (開始直後から読み込まない)。
    await parkNearEnd(audio, 1700);
    expect(audioInstances.length).toBe(1);

    // 残り50秒: 次の曲 (エピソード2) の先読みが始まる。
    await parkNearEnd(audio, 1750);
    expect(audioInstances.length).toBe(2);
    expect(preloadInstance()).not.toBe(audio);
    expect(preloadInstance().src).toBe('https://example.com/ep2.mp3');
    expect(preloadInstance().preload).toBe('auto');
    expect(errors).toEqual([]);
  });

  it('遷移時に先読みは破棄される', async () => {
    await mountPlayer();
    await startCard(0);
    const audio = latestAudio();
    await parkNearEnd(audio, 1750);
    const pre = preloadInstance();
    expect(pre.src).toBe('https://example.com/ep2.mp3');

    audio.ended = true;
    audio.paused = true;
    audio.dispatchEvent(new window.Event('ended'));
    await flush();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(pre.src).toBe('');
    expect(errors).toEqual([]);
  });

  it('単曲リピートでは先読みしない', async () => {
    await mountPlayer();
    const bar = await startCard(0);
    const audio = latestAudio();
    const repeatBtn = () => bar.querySelector('button[aria-label^="リピート"]');
    repeatBtn().click();
    await flush();
    repeatBtn().click();
    await flush();
    expect(repeatBtn().getAttribute('aria-label')).toBe('リピート：1曲');

    await parkNearEnd(audio, 1750);
    expect(audioInstances.length).toBe(1);
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
