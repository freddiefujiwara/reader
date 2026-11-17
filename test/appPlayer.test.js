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

// ローカルでは API_URL はプレースホルダ (CI がビルド時に置換) で
// 空になり、起動処理が止まってしまうため、値が入った形に差し替える。
vi.mock('../src/config.js', () => ({
  API_URL: 'https://example.com/exec',
  GOOGLE_CLIENT_ID: 'test-client-id',
}));

import App from '../src/App.vue';
import { listArticles } from '../src/lib/api.js';
import { loadLocalArticles, saveLocalFeeds, putLocalArticles, deleteLocalArticles } from '../src/lib/localDb.js';

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

describe('プレイヤーの自動送り (全体繰り返しと単曲繰り返し)', () => {
  // 「リピートON」= 全体繰り返し: 末尾まで行ったら先頭に戻って続ける。
  it('全体繰り返しでは、末尾の次は先頭に戻って再生が続く', async () => {
    await mountPlayer();
    const bar = await startCard(0);
    const repeatBtn = () => bar.querySelector('button[aria-label^="リピート"]');
    repeatBtn().click();
    await flush();
    expect(repeatBtn().getAttribute('aria-label')).toBe('リピート：全曲');

    await fireEnded();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');

    await fireEnded();
    // 末尾の次は止まらず、先頭のエピソード1へ戻る。
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(latestAudio().src).toBe('https://example.com/ep1.mp3');
  });

  // 単曲繰り返しは OFF／ON の言い方の対象外で、従来どおり同じ
  // エピソードを先頭から再生し直す。
  it('単曲繰り返しでは、終わっても同じエピソードを再生し直す', async () => {
    await mountPlayer();
    const bar = await startCard(0);
    const repeatBtn = () => bar.querySelector('button[aria-label^="リピート"]');
    repeatBtn().click();
    await flush();
    repeatBtn().click();
    await flush();
    expect(repeatBtn().getAttribute('aria-label')).toBe('リピート：1曲');

    await fireEnded();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(latestAudio().src).toBe('https://example.com/ep1.mp3');
    // 先頭から再生が再開している (要素は再生中)。
    expect(latestAudio().paused).toBe(false);
    expect(latestAudio().currentTime).toBe(0);
  });
});

describe('前へ／次へボタン', () => {
  it('blog と同じアイコンとラベルで、再生ボタンの左右に付く', async () => {
    await mountPlayer();
    const bar = await startCard(0);
    const prev = bar.querySelector('button[aria-label="前へ"]');
    const next = bar.querySelector('button[aria-label="次へ"]');
    expect(prev, '前へボタン').toBeTruthy();
    expect(next, '次へボタン').toBeTruthy();
    expect(prev.getAttribute('title')).toBe('前へ');
    expect(next.getAttribute('title')).toBe('次へ');
    // blog の musicPlayer と同じ SVG パス (skip-previous / skip-next)。
    expect(prev.querySelector('path').getAttribute('d')).toBe('M6 5h2v14H6zM20 5v14L9 12z');
    expect(next.querySelector('path').getAttribute('d')).toBe('M16 5h2v14h-2zM4 5v14l11-7z');
    // 並びは blog と同じく 前へ → 再生 → 次へ。
    const controls = [...bar.querySelector('.player-controls').children];
    const playIdx = controls.findIndex((b) => b.classList.contains('player-play'));
    expect(controls[playIdx - 1]).toBe(prev);
    expect(controls[playIdx + 1]).toBe(next);
    expect(errors).toEqual([]);
  });

  it('次へで次のエピソードへ進み、末尾では先頭へ折り返す', async () => {
    await mountPlayer();
    const bar = await startCard(0);
    const next = () => bar.querySelector('button[aria-label="次へ"]');
    next().click();
    await flush();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(latestAudio().src).toBe('https://example.com/ep2.mp3');

    next().click();
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(latestAudio().src).toBe('https://example.com/ep1.mp3');
  });

  it('前へで前のエピソードへ戻り、先頭では末尾へ折り返す', async () => {
    await mountPlayer();
    const bar = await startCard(0);
    const prev = () => bar.querySelector('button[aria-label="前へ"]');
    prev().click();
    await flush();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(latestAudio().src).toBe('https://example.com/ep2.mp3');

    prev().click();
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(latestAudio().src).toBe('https://example.com/ep1.mp3');
  });
});

describe('フィルタのトグル選択 (「すべて」廃止)', () => {
  const chipByText = (root, text) =>
    [...root.querySelectorAll('button.chip')].find((b) => b.textContent.trim().startsWith(text));

  it('カテゴリとチャンネルのチップに「すべて」が無く、未選択が初期状態', async () => {
    await mountPlayer();
    const chips = [...el.querySelectorAll('.feed-chips button.chip')];
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.some((b) => b.textContent.trim() === 'すべて')).toBe(false);
    expect(chips.some((b) => b.classList.contains('active'))).toBe(false);
    // 既読状態の切替 (すべて／未読) は対象外で、従来どおり残る。
    const tabs = [...el.querySelectorAll('.view-tabs button')].map((b) => b.textContent.trim());
    expect(tabs).toEqual(['すべて', '未読']);
    expect(errors).toEqual([]);
  });

  it('カテゴリは再タップで解除され、全件表示に戻る', async () => {
    await mountPlayer();
    const chip = () => chipByText(el.querySelector('.category-chips'), 'ポッドキャスト');
    expect(chip()).toBeTruthy();
    chip().click();
    await flush();
    expect(chip().classList.contains('active')).toBe(true);
    expect(el.querySelectorAll('.article-card').length).toBe(2);

    chip().click();
    await flush();
    expect(errors).toEqual([]);
    expect(chip().classList.contains('active')).toBe(false);
    expect(el.querySelectorAll('.article-card').length).toBe(2);
  });

  it('チャンネルは再タップで解除され、全件表示に戻る', async () => {
    await mountPlayer();
    const chip = () => chipByText(el.querySelector('.feed-chips:not(.category-chips)'), 'Rebuild');
    expect(chip()).toBeTruthy();
    chip().click();
    await flush();
    expect(chip().classList.contains('active')).toBe(true);
    expect(el.querySelectorAll('.article-card').length).toBe(2);

    chip().click();
    await flush();
    expect(errors).toEqual([]);
    expect(chip().classList.contains('active')).toBe(false);
    expect(el.querySelectorAll('.article-card').length).toBe(2);
  });
});

describe('キューの範囲 (表示条件に合う全フィード)', () => {
  // https://example.com/feed2.xml のハッシュID (feedHash で固定済み)。
  const FEED2 = {
    ...FEED,
    id: '77699cb82a926f0e',
    title: 'Feed2',
    url: 'https://example.com/feed2.xml',
    unreadCount: 1,
  };
  const recOn = (feedId) => (id, title, published_at, audio_url) => ({
    ...rec(id, title, published_at, audio_url),
    feed_id: feedId,
  });
  const A1 = recOn(FEED_ID)('a-1', 'フィード1の新', '2026-11-14T00:00:00.000Z', 'https://example.com/a1.mp3');
  const B1 = recOn(FEED2.id)('b-1', 'フィード2の話', '2026-11-13T00:00:00.000Z', 'https://example.com/b1.mp3');
  const A2 = recOn(FEED_ID)('a-2', 'フィード1の旧', '2026-11-12T00:00:00.000Z', 'https://example.com/a2.mp3');

  it('自動送りはフィードをまたいで表示順に進み、末尾で止まる', async () => {
    // 起動時の更新はサーバー側フィード一覧に無い記事を孤児として落とす
    // ため、このテストの間だけ listArticles のモックに FEED2 も含める。
    // IndexedDB はファイル内のテストで共有されるため、先行テストの記事を
    // 消してから種まきし、後始末 (モック復旧と記事の削除) は finally で行う。
    listArticles.mockResolvedValue({ ok: true, feeds: [FEED, FEED2], articles: [] });
    try {
      const before = await loadLocalArticles();
      if (before.length) await deleteLocalArticles(before.map((r) => r.id));
      await saveLocalFeeds([FEED, FEED2]);
      await putLocalArticles([{ ...A1 }, { ...B1 }, { ...A2 }]);
      el = document.createElement('div');
      document.body.appendChild(el);
      app = createApp(App);
      app.config.errorHandler = (err) => { errors.push(err); };
      app.mount(el);
      await flush();
      expect(el.querySelectorAll('.article-card').length, '記事カードが3件出る').toBe(3);

      const bar = await startCard(0);
      expect(errors).toEqual([]);
      expect(bar.querySelector('.player-title').textContent).toBe('フィード1の新');

      await fireEnded();
      expect(errors).toEqual([]);
      expect(el.querySelector('.player-title').textContent).toBe('フィード2の話');
      expect(latestAudio().src).toBe('https://example.com/b1.mp3');

      await fireEnded();
      expect(el.querySelector('.player-title').textContent).toBe('フィード1の旧');

      await fireEnded();
      expect(el.querySelector('.player-title').textContent).toBe('フィード1の旧');
    } finally {
      listArticles.mockResolvedValue({ ok: true, feeds: [FEED], articles: [] });
      await deleteLocalArticles(['a-1', 'b-1', 'a-2']);
    }
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

  it('learned と同じモデルで実測が完了しても、実測済みとして到達判定が開く', async () => {
    // 前回分のモデルが端末に残っていて、それがこの曲でも正しい状態。
    localStorage.setItem('reader:player-timemodel:v1', 'scaled');
    await mountWithRecords([ytRec(EP1), ytRec(EP2)]);
    await startCard(0);
    const audio = latestAudio();
    audio.duration = 208; // 要素は実尺 104 の2倍を報告する
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    await flush();

    // 実測の窓を作る: 要素時間が 10 進む → 'scaled' と分類される。
    // learned と同じ結果なので乗り換えは起きないが、分類が完了
    // したこと自体が実測済みとして記録され、到達判定のゲートが
    // 開く (従来は乗り換えの条件の中でだけ記録していたため、
    // measuredModel が null のまま残り、ゲートが永久に開かず、
    // 実機で終端に止まり続けた)。
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
      audio.currentTime = 207.6;
      audio.dispatchEvent(new window.Event('timeupdate'));
      await flush();
    } finally {
      nowSpy.mockRestore();
    }
    expect(audio.ended).toBe(false);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(true);
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

describe('既知の長さへの到達による終了判定 (durationSec 到達)', () => {
  const knownRec = (base) => ({ ...base, duration_sec: 100 });

  // 実尺 100 秒・要素の報告も 100 秒 (一致する通常の曲) で開始する。
  async function startKnown(records) {
    await mountWithRecords(records);
    await startCard(0);
    const audio = latestAudio();
    audio.duration = 100;
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    await flush();
    return audio;
  }

  it('要素の長さが実尺と一致する曲で、表示位置が実尺に到達したら ended が来なくても次へ進む', async () => {
    const audio = await startKnown([knownRec(EP1), knownRec(EP2)]);
    // 手前 (95) では進まない。
    audio.currentTime = 95;
    audio.dispatchEvent(new window.Event('timeupdate'));
    await flush();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');

    // 実尺に到達 → 'ended' イベントなしで終了フローが走る
    // (従来は、要素 duration と実尺が一致する曲では 'ended' が
    // 唯一の頼りで、このケースでは進まなかった)。
    audio.currentTime = 100;
    audio.dispatchEvent(new window.Event('timeupdate'));
    await flush();
    expect(audio.ended).toBe(false);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('durationSec が丸めで真の長さより長くても、駐留位置で到達とみなして次へ進む', async () => {
    // 真の長さ 100 秒のメディアが、itunes:duration の四捨五入で
    // durationSec = 100.49 になったケース。要素は真の終端 (100)
    // で止まる。従来の許容誤差 (0.3秒) では閾値 (100.19) が
    // 駐留位置より上になり、到達判定が届かなかった。
    await mountWithRecords([{ ...EP1, duration_sec: 100.49 }, { ...EP2, duration_sec: 100.49 }]);
    await startCard(0);
    const audio = latestAudio();
    audio.duration = 100;
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    await flush();
    audio.currentTime = 100;
    audio.dispatchEvent(new window.Event('timeupdate'));
    await flush();
    expect(audio.ended).toBe(false);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('既知の長さの手前 (95) では、到達判定では終了しない', async () => {
    const audio = await startKnown([knownRec(EP1), knownRec(EP2)]);
    audio.currentTime = 95;
    audio.dispatchEvent(new window.Event('timeupdate'));
    await flush();
    audio.dispatchEvent(new window.Event('timeupdate'));
    await flush();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(false);
    expect(errors).toEqual([]);
  });

  it('durationSec が無い曲では、位置が要素の終端に達しても到達判定では進まない', async () => {
    await mountWithRecords([{ ...EP1, duration_sec: null }, { ...EP2, duration_sec: null }]);
    await startCard(0);
    const audio = latestAudio();
    audio.duration = 100;
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    await flush();
    audio.currentTime = 100;
    audio.dispatchEvent(new window.Event('timeupdate'));
    await flush();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(false);
    expect(errors).toEqual([]);
  });

  it('一時停止中は、位置が既知の長さに達していても終了しない', async () => {
    const audio = await startKnown([knownRec(EP1), knownRec(EP2)]);
    audio.currentTime = 100;
    audio.pause();
    await flush();
    audio.dispatchEvent(new window.Event('timeupdate'));
    await flush();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(false);
    expect(errors).toEqual([]);
  });

  it('終端で timeupdate が止まっても、タイマーの tick が到達を拾って次へ進む', async () => {
    vi.useFakeTimers();
    try {
      // 偽タイマー用のポンプとマウント。
      const flushFake = async () => {
        for (let i = 0; i < 10; i += 1) {
          await vi.advanceTimersByTimeAsync(10);
          await new Promise((r) => realSetTimeout(r, 1));
          await nextTick();
        }
      };
      let seeded = false;
      const seeding = (async () => {
        await saveLocalFeeds([FEED]);
        await putLocalArticles([knownRec(EP1), knownRec(EP2)]);
        seeded = true;
      })();
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
      el.querySelectorAll('.article-card')[0].querySelector('.play-btn').click();
      await flushFake();
      const audio = latestAudio();
      audio.duration = 100;
      audio.dispatchEvent(new window.Event('loadedmetadata'));
      await flushFake();

      // timeupdate を送らず、要素の位置だけを実尺に置く (終端で
      // イベントが止まった状態)。タイマーが進むまでは進まない。
      audio.currentTime = 100;
      expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
      // 終端チェックのタイマーの tick (0.5秒) が要素の位置を
      // 見て到達を拾い、次へ進む。
      await vi.advanceTimersByTimeAsync(500);
      await flushFake();
      expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
      expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// 偽タイマーを入れる前に、本物の setTimeout を控えておく (ポンプ用)。
const realSetTimeout = globalThis.setTimeout;

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

  it('次の曲の実尺の10%以下になると先読みし、それより前はしない', async () => {
    await mountPlayer();
    await startCard(0);
    const audio = latestAudio();
    expect(audioInstances.length).toBe(1);

    // 次の曲は30分 (1800秒) なのでリードは180秒。残り200秒では
    // まだ先読みしない (開始直後から読み込まない)。
    await parkNearEnd(audio, 1600);
    expect(audioInstances.length).toBe(1);

    // 残り100秒: 次の曲 (エピソード2) の先読みが始まる。
    await parkNearEnd(audio, 1700);
    expect(audioInstances.length).toBe(2);
    expect(preloadInstance()).not.toBe(audio);
    expect(preloadInstance().src).toBe('https://example.com/ep2.mp3');
    expect(preloadInstance().preload).toBe('auto');
    expect(errors).toEqual([]);
  });

  it('次の曲の実尺が不明なら従来どおり残り60秒で先読みする', async () => {
    await mountWithRecords([{ ...EP1 }, { ...EP2, duration_sec: null }]);
    await startCard(0);
    const audio = latestAudio();
    expect(audioInstances.length).toBe(1);

    // 残り100秒: リードは下限の60秒なので、まだ先読みしない。
    await parkNearEnd(audio, 1700);
    expect(audioInstances.length).toBe(1);

    // 残り50秒: 先読みが始まる。
    await parkNearEnd(audio, 1750);
    expect(audioInstances.length).toBe(2);
    expect(preloadInstance().src).toBe('https://example.com/ep2.mp3');
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

  it('読み込み中は一覧側の当該エピソードの再生ボタンも「…」になり、再生可能になると戻る', async () => {
    await mountPlayer();
    await startCard(0);
    const cardBtn = () => el.querySelectorAll('.article-card')[0].querySelector('.play-btn');
    const otherBtn = () => el.querySelectorAll('.article-card')[1].querySelector('.play-btn');
    // プレイヤー本体と同じ読み込み待ちステータスが、再生中の
    // エピソードのカード側ボタンにも連動する。
    expect(cardBtn().getAttribute('aria-label')).toBe('読み込み中');
    expect(cardBtn().textContent).toContain('…');
    expect(cardBtn().querySelector('svg')).toBeNull();
    // 他のエピソードのボタンは通常の再生アイコンのまま。
    expect(otherBtn().getAttribute('aria-label')).toBe('再生');
    expect(otherBtn().querySelector('svg')).toBeTruthy();
    expect(otherBtn().textContent).not.toContain('…');

    latestAudio().dispatchEvent(new window.Event('canplay'));
    await flush();
    expect(cardBtn().getAttribute('aria-label')).toBe('一時停止');
    expect(cardBtn().querySelector('svg')).toBeTruthy();
    expect(cardBtn().textContent).not.toContain('…');
    expect(errors).toEqual([]);
  });
});

describe('切り替わり時の開始位置 (次の曲の頭が飛ぶ不具合)', () => {
  // 再生開始 (loadedmetadata) まで進めて、要素へ適用された開始位置を返す。
  async function startAndSettle(idx) {
    await startCard(idx);
    const audio = latestAudio();
    audio.duration = 1800; // 実尺どおり (duration_sec = 1800)
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    await flush();
    return audio;
  }

  it('自動送りでは、次のエピソードに保存位置があっても 0 から始まる', async () => {
    // 次のエピソードに前回分の保存位置 (900 = 中盤) がある状態。
    await mountWithRecords([{ ...EP1 }, { ...EP2, play_pos: 900 }]);
    const audio = await startAndSettle(0);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');

    await fireEnded();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    audio.duration = 1800;
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    await flush();
    // 切り替わりでは保存位置を使わず、頭から始まる。
    expect(audio.currentTime).toBe(0);
    expect(errors).toEqual([]);
  });

  it('自動送りでは、実例と同じ数秒の保存位置でも 0 から始まる', async () => {
    // 実機の実例: 次の曲に 3 秒の保存位置があり、切り替わり直後の
    // 表示が 0:03 になった。
    await mountWithRecords([{ ...EP1 }, { ...EP2, play_pos: 3 }]);
    const audio = await startAndSettle(0);

    await fireEnded();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    audio.duration = 1800;
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    await flush();
    expect(audio.currentTime).toBe(0);
    expect(errors).toEqual([]);
  });

  it('次へボタンでも、次のエピソードは保存位置を使わず 0 から始まる', async () => {
    await mountWithRecords([{ ...EP1 }, { ...EP2, play_pos: 900 }]);
    const bar = await startAndSettle(0).then(() => el.querySelector('.player-bar'));
    bar.querySelector('button[aria-label="次へ"]').click();
    await flush();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    const audio = latestAudio();
    audio.duration = 1800;
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    await flush();
    expect(audio.currentTime).toBe(0);
    expect(errors).toEqual([]);
  });

  it('前へボタンでも、戻り先のエピソードは保存位置を使わず 0 から始まる', async () => {
    await mountWithRecords([{ ...EP1, play_pos: 900 }, { ...EP2 }]);
    const bar = await startAndSettle(1).then(() => el.querySelector('.player-bar'));
    bar.querySelector('button[aria-label="前へ"]').click();
    await flush();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    const audio = latestAudio();
    audio.duration = 1800;
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    await flush();
    expect(audio.currentTime).toBe(0);
    expect(errors).toEqual([]);
  });

  it('カードから直接選んだ場合は、従来どおり保存位置から再開する', async () => {
    await mountWithRecords([{ ...EP1 }, { ...EP2, play_pos: 900 }]);
    const audio = await startAndSettle(1);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(audio.currentTime).toBe(900);
    expect(errors).toEqual([]);
  });

  it('冒頭数秒の保存位置は、直接選んでも再開位置として使わない', async () => {
    // 数秒だけ再生して止めた程度の位置は「途中」ではなく頭。
    // 終端間際 (RESUME_END_GUARD_SEC) と対称に、冒頭側も再開位置
    // として扱わない。
    await mountWithRecords([{ ...EP1 }, { ...EP2, play_pos: 3 }]);
    const audio = await startAndSettle(1);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(audio.currentTime).toBe(0);
    expect(errors).toEqual([]);
  });

  it('冒頭数秒で止めても、再開位置として保存されない', async () => {
    await mountPlayer();
    const audio = await startAndSettle(0);
    audio.currentTime = 3;
    audio.pause();
    await flush();
    const saved = (await loadLocalArticles()).find((r) => r.id === 'ep-1');
    expect(saved.play_pos).toBe(0);
    expect(errors).toEqual([]);
  });
});

describe('フォアグラウンド復帰時の再生回復', () => {
  // バックグラウンドから戻ってきたことを、visibilitychange の
  // 発火で模す (既存の位置保存テストと同じ流儀)。
  async function fireVisible() {
    document.dispatchEvent(new window.Event('visibilitychange'));
    await flush();
  }

  it('要素だけが終わっていて ended が来ていない状態で復帰すると、次へ進む', async () => {
    await mountPlayer();
    await startCard(0);
    const audio = latestAudio();
    // バックグラウンドで曲が終わったが、'ended' イベントも
    // 終了判定のタイマーも suspend されて届かなかった状態。
    audio.ended = true;
    audio.paused = true;
    await fireVisible();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(audio.src).toBe('https://example.com/ep2.mp3');
    expect(audio.paused).toBe(false);
  });

  it('自動送りの play() が NotAllowedError で拒否されても曲を飛ばさず、復帰で再生が始まる', async () => {
    await mountPlayer();
    await startCard(0);
    const audio = latestAudio();
    // 次曲への送りで呼ばれる play() が、バックグラウンドでの
    // ブロックを模して NotAllowedError で拒否されるようにする
    // (新しいリソースを読み始めた要素として ended は下ろす)。
    const originalPlay = audio.play.bind(audio);
    audio.play = () => {
      audio.ended = false;
      audio.paused = true;
      const err = new Error('blocked');
      err.name = 'NotAllowedError';
      return Promise.reject(err);
    };
    await fireEnded();
    // 失敗扱いで送られたりせず、次曲に留まっている。
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(audio.paused).toBe(true);
    // フォアグラウンドへ戻ると、留まっていた次曲の再生が始まる。
    audio.play = originalPlay;
    await fireVisible();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(audio.paused).toBe(false);
  });

  it('本人が一時停止していたら、復帰しても勝手に再生しない', async () => {
    await mountPlayer();
    await startCard(0);
    const audio = latestAudio();
    // 再生中のカードのボタンをもう一度押す = 本人の一時停止。
    el.querySelectorAll('.article-card')[0].querySelector('.play-btn').click();
    await flush();
    expect(audio.paused).toBe(true);
    await fireVisible();
    expect(errors).toEqual([]);
    expect(audio.paused).toBe(true);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
  });
});

describe('タイトル押下と再生の継続', () => {
  it('再生中にタイトルを押しても、ページを開き直さず再生が続く', async () => {
    await mountPlayer();
    const bar = await startCard(0);
    expect(bar, 'プレイヤーバーが出る').toBeTruthy();
    const audio = latestAudio();
    expect(audio.paused).toBe(false);
    el.querySelector('.brand').click();
    await flush();
    expect(errors).toEqual([]);
    // 同じ音声要素が再生中のまま、プレイヤーバーも残る。
    expect(audio.paused).toBe(false);
    expect(audio.src).toBe('https://example.com/ep1.mp3');
    expect(el.querySelector('.player-bar .player-title').textContent).toBe('エピソード1');
    // 画面はタイムラインのまま。
    expect(el.querySelector('.view-tabs')).toBeTruthy();
  });
});
