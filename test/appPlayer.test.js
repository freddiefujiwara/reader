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

// ローカルでは API_URL はプレースホルダ (CI がビルド時に置換) で
// 空になり、起動処理が止まってしまうため、値が入った形に差し替える。
vi.mock('../src/config.js', () => ({
  API_URL: 'https://example.com/exec',
  GOOGLE_CLIENT_ID: 'test-client-id',
}));

import App from '../src/App.vue';
import { listArticles, logEvents } from '../src/lib/api.js';
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

describe('プレイヤーの自動送り (終了時の処理順序)', () => {
  // バックグラウンドでは曲間の無音の隙間にページが凍結されうるため、
  // 終了経路では次曲の play() を、後処理 (視聴ログ送信など) より
  // 先に発行しなければならない。その順序を固定する。
  it('次曲の play() が視聴ログ送信より先に呼ばれる', async () => {
    let nowVal = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => nowVal);
    const order = [];
    const origPlay = FakeAudio.prototype.play;
    FakeAudio.prototype.play = function () {
      order.push(`play:${this.src}`);
      return origPlay.call(this);
    };
    logEvents.mockImplementation(async () => {
      order.push('logEvents');
      return { ok: true, saved: 0 };
    });
    try {
      await mountPlayer();
      await startCard(0);
      // 1曲目を10秒聴いたことにする (play イベントの確定対象にする)。
      nowVal = 10_000;
      order.length = 0;
      await fireEnded();
      expect(errors).toEqual([]);
      const playIdx = order.indexOf('play:https://example.com/ep2.mp3');
      const logIdx = order.indexOf('logEvents');
      expect(playIdx, '次曲の play() が呼ばれる').toBeGreaterThanOrEqual(0);
      expect(logIdx, '視聴ログが送られる').toBeGreaterThanOrEqual(0);
      expect(playIdx).toBeLessThan(logIdx);
      // 後処理 (既読化) も従来どおり行われる。
      expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(true);
    } finally {
      FakeAudio.prototype.play = origPlay;
      logEvents.mockImplementation(async () => ({ ok: true, saved: 0 }));
      nowSpy.mockRestore();
    }
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

  it('本人が一時停止していたら、位置が既知の長さに達していても終了しない', async () => {
    const audio = await startKnown([knownRec(EP1), knownRec(EP2)]);
    audio.currentTime = 100;
    // 再生中のカードのボタンをもう一度押す = 本人の一時停止
    // (playWanted が下りる)。到達判定の入口は再生の意思で見る
    // ため、'pause' 経由でも timeupdate 経由でも進まない。
    el.querySelectorAll('.article-card')[0].querySelector('.play-btn').click();
    await flush();
    expect(audio.paused).toBe(true);
    audio.dispatchEvent(new window.Event('timeupdate'));
    await flush();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(false);
    expect(errors).toEqual([]);
  });

  it('終端で要素が ended を出さずに止まっても、pause 経由の検出で次へ進む', async () => {
    const audio = await startKnown([knownRec(EP1), knownRec(EP2)]);
    // 要素側の都合で終端に止まった (本人の操作ではない)。
    // 以前は、この 'pause' で isPlaying が下りて到達判定自体が
    // 無効化され、進まなかった。
    audio.currentTime = 100;
    audio.pause();
    await flush();
    expect(audio.ended).toBe(false);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('中盤で要素が止まっても、pause 経由では進まない', async () => {
    const audio = await startKnown([knownRec(EP1), knownRec(EP2)]);
    audio.currentTime = 50;
    audio.pause();
    await flush();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(false);
    expect(errors).toEqual([]);
  });

  it('残り2秒では次へ進まない (到達の許容は 0.6 秒に統一)', async () => {
    const audio = await startKnown([knownRec(EP1), knownRec(EP2)]);
    // 到達の許容は曲の種別によらず 0.6 秒。残り 2 秒は許容の
    // 外なので進まない (PR #105 の YouTube 曲だけの前倒しは
    // 末尾を切り捨てるため廃止した)。
    audio.currentTime = 98;
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

describe('次の曲の先読み (二重バッファ)', () => {
  // 先読みは待機側の2つ目の要素へ読み込み、終了時は役割交代で
  // そのまま再生に使う。要素は必要になるまで作られないので、
  // 作られたかどうかはインスタンス数で見る。
  const preloadInstance = () => audioInstances[audioInstances.length - 1];

  async function parkNearEnd(audio, pos) {
    audio.duration = 1800;
    audio.dispatchEvent(new window.Event('loadedmetadata'));
    audio.currentTime = pos;
    audio.dispatchEvent(new window.Event('timeupdate'));
    await flush();
  }

  // 再生が始まったことにして先読みを開始させ、待機要素を返す。
  async function startPreload(audio) {
    audio.dispatchEvent(new window.Event('playing'));
    await flush();
    return preloadInstance();
  }

  it('再生が始まるまでは先読みせず、始まったら残り時間によらず先読みする', async () => {
    await mountPlayer();
    await startCard(0);
    const audio = latestAudio();
    // play() は呼ばれたが 'playing' (実際の再生開始) はまだ。
    expect(audioInstances.length).toBe(1);

    // 再生が始まったら、その時点で次曲の先読みが始まる
    // (かつての残り60秒方式ではない)。
    const pre = await startPreload(audio);
    expect(audioInstances.length).toBe(2);
    expect(pre).not.toBe(audio);
    expect(pre.src).toBe('https://example.com/ep2.mp3');
    expect(pre.preload).toBe('auto');
    expect(errors).toEqual([]);
  });

  it('次の曲の実尺が不明でも、再生が始まれば先読みする', async () => {
    await mountWithRecords([{ ...EP1 }, { ...EP2, duration_sec: null }]);
    await startCard(0);
    const audio = latestAudio();
    expect(audioInstances.length).toBe(1);

    const pre = await startPreload(audio);
    expect(audioInstances.length).toBe(2);
    expect(pre.src).toBe('https://example.com/ep2.mp3');
    expect(errors).toEqual([]);
  });

  it('終了時は先読み済みの要素へ役割交代し、旧要素は待機側として空になる', async () => {
    // 次曲には保存位置 (900) があるが、自動送りでは使わない。
    await mountWithRecords([{ ...EP1 }, { ...EP2, play_pos: 900 }]);
    await startCard(0);
    const audio = latestAudio();
    const pre = await startPreload(audio);
    expect(pre.src).toBe('https://example.com/ep2.mp3');
    pre.duration = 1800; // 待機側でメタデータまで読めた状態

    audio.ended = true;
    audio.paused = true;
    audio.dispatchEvent(new window.Event('ended'));
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    // 遷移で新しい要素は作られず、先読み側がそのまま再生される。
    expect(audioInstances.length).toBe(2);
    expect(pre.paused).toBe(false);
    expect(pre.src).toBe('https://example.com/ep2.mp3');
    // 切り替わりでは保存位置を使わず頭から。長さは先読み側の
    // メタデータから引き継がれる ('loadedmetadata' は来ない)。
    expect(pre.currentTime).toBe(0);
    expect(el.querySelector('.player-total').textContent).toBe('30:00');
    // 旧要素は待機側になり、止めて空に戻される。
    expect(audio.paused).toBe(true);
    expect(audio.src).toBe('');
    // 聴き終えた1件目は既読表示になる。
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(true);
  });

  it('待機側のイベント (ended / pause) では進まず、状態も壊れない', async () => {
    await mountPlayer();
    await startCard(0);
    const audio = latestAudio();
    const pre = await startPreload(audio);

    // 待機側で終端や停止のイベントが来ても、本体には響かない。
    pre.ended = true;
    pre.dispatchEvent(new window.Event('ended'));
    pre.dispatchEvent(new window.Event('pause'));
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(audio.paused).toBe(false);
    expect(el.querySelectorAll('.article-card')[0].classList.contains('is-read')).toBe(false);
  });

  it('先読みが始まった直後 (ほぼ進んでいない状態) でも役割交代する', async () => {
    // 前の曲が短く、先読みの窓がほとんど無いケース。待機側は
    // src をセットしただけで、メタデータも来ていない。
    await mountPlayer();
    await startCard(0);
    const audio = latestAudio();
    const pre = await startPreload(audio);
    expect(pre.src).toBe('https://example.com/ep2.mp3');
    expect(Number.isFinite(pre.duration)).toBe(false);

    audio.ended = true;
    audio.paused = true;
    audio.dispatchEvent(new window.Event('ended'));
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    // 読み込み途中の待機側がそのまま昇格して再生される。
    expect(audioInstances.length).toBe(2);
    expect(pre.paused).toBe(false);
    expect(pre.src).toBe('https://example.com/ep2.mp3');
    expect(audio.src).toBe('');
  });

  it('先読みが1回失敗しても、その場で読み直した試行が生きていれば役割交代する', async () => {
    await mountPlayer();
    await startCard(0);
    const audio = latestAudio();
    const pre = await startPreload(audio);

    // 待機側の読み込みエラー (一時的な失敗)。本体の再生には
    // 波及しない。その場で同じ URL の読み直しが始まり、非同期の
    // URL 再解決 (モックでは失敗する) の完了は待たない。
    pre.dispatchEvent(new window.Event('error'));
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(audio.paused).toBe(false);
    expect(pre.src).toBe('https://example.com/ep2.mp3');

    // 終了時は、読み直した試行のまま役割交代して再生される。
    audio.ended = true;
    audio.paused = true;
    audio.dispatchEvent(new window.Event('ended'));
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(audioInstances.length).toBe(2);
    expect(pre.paused).toBe(false);
    expect(pre.src).toBe('https://example.com/ep2.mp3');
    expect(audio.src).toBe('');
  });

  it('先読みが繰り返し失敗したら、遷移時はアクティブ側へ読み込む従来経路に倒れる', async () => {
    await mountPlayer();
    await startCard(0);
    const audio = latestAudio();
    const pre = await startPreload(audio);

    // 1回目のエラーではその場で読み直すが、読み直した試行も
    // エラーになり、URL の再解決 (モック) も失敗する。本体の
    // 再生には波及しない。
    pre.dispatchEvent(new window.Event('error'));
    await flush();
    pre.dispatchEvent(new window.Event('error'));
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(audio.paused).toBe(false);

    // 終了時は役割交代せず、従来どおりアクティブ側へ次曲を載せる。
    audio.ended = true;
    audio.paused = true;
    audio.dispatchEvent(new window.Event('ended'));
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(audio.src).toBe('https://example.com/ep2.mp3');
    expect(audio.paused).toBe(false);
    // 駄目だった先読みは破棄される。
    expect(pre.src).toBe('');
  });

  it('待機側の URL が遷移先と食い違っていたら役割交代しない', async () => {
    await mountPlayer();
    await startCard(0);
    const audio = latestAudio();
    const pre = await startPreload(audio);

    // 先読み対象は次曲のまま、待機側に載っている URL だけが
    // 食い違っている状態 (古い URL のまま残った等)。
    pre.src = 'https://example.com/other.mp3';

    audio.ended = true;
    audio.paused = true;
    audio.dispatchEvent(new window.Event('ended'));
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    // 役割交代せず、アクティブ側へ遷移先の URL を載せ直す。
    expect(audio.src).toBe('https://example.com/ep2.mp3');
    expect(audio.paused).toBe(false);
    expect(pre.src).toBe('');
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

describe('ランダム再生の先読み (確定した次曲への役割交代)', () => {
  // ランダムでは次曲が遷移時の抽選で決まっていたため先読みの
  // 対象外だったが、武装の時点で1件抽選して確定させることで、
  // リスト順と同じく役割交代 (advance_swap) で進めるようにする。
  // 固定したいのは、確定と遷移先が一致することと、確定が無効に
  // なる操作 (モード切替・本人の選び直し) で破棄されること、
  // ラウンド内で同じ曲が二重に選ばれないこと。
  const EP3 = rec('ep-3', 'エピソード3', '2026-11-12T00:00:00.000Z', 'https://example.com/ep3.mp3');

  afterEach(async () => {
    // ep-3 は共有の IndexedDB に残ると、他のテストの種まき
    // (2件前提) を壊すので毎回消しておく。
    await deleteLocalArticles(['ep-3']);
  });

  async function mountWithEpisodes(records) {
    await saveLocalFeeds([FEED]);
    await putLocalArticles(records);
    el = document.createElement('div');
    document.body.appendChild(el);
    app = createApp(App);
    app.config.errorHandler = (err) => { errors.push(err); };
    app.mount(el);
    await flush();
    expect(el.querySelectorAll('.article-card').length, '記事カードが出る').toBe(records.length);
  }

  async function toggleShuffleBtn(bar) {
    bar.querySelector('button[aria-label^="ランダム"]').click();
    await flush();
  }

  // 再生が始まったことにして先読みを開始させ、待機要素を返す。
  async function armPreload(active) {
    active.dispatchEvent(new window.Event('playing'));
    await flush();
    return audioInstances[audioInstances.length - 1];
  }

  async function endActive(active) {
    active.ended = true;
    active.paused = true;
    active.dispatchEvent(new window.Event('ended'));
    await flush();
  }

  it('ランダムでも再生開始で次曲が確定して先読みされ、終了時はその曲へ役割交代する', async () => {
    await mountWithEpisodes([{ ...EP1 }, { ...EP2 }]);
    const bar = await startCard(0);
    await toggleShuffleBtn(bar);
    expect(bar.querySelector('button[aria-label^="ランダム"]').getAttribute('aria-label')).toBe('ランダム：オン');
    const audio = latestAudio();

    // 候補は ep-2 だけなので、抽選は一意に定まる。
    const pre = await armPreload(audio);
    expect(audioInstances.length).toBe(2);
    expect(pre.src).toBe('https://example.com/ep2.mp3');

    await endActive(audio);
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    // 役割交代で進み、診断にも advance_swap が残る。
    expect(audioInstances.length).toBe(2);
    expect(pre.paused).toBe(false);
    expect(audio.src).toBe('');
    const diag = logEvents.mock.calls.flatMap((c) => c[1]).filter((e) => e.type.startsWith('advance_'));
    expect(diag).toEqual([
      expect.objectContaining({ type: 'advance_swap', article_id: 'ep-2' }),
    ]);
  });

  it('ランダムをオフにすると確定が破棄され、リスト順の次曲へ進む', async () => {
    await mountWithEpisodes([{ ...EP1 }, { ...EP2 }, { ...EP3 }]);
    const bar = await startCard(0);
    await toggleShuffleBtn(bar);
    const audio = latestAudio();

    // 抽選を候補の末尾 (ep-3) に寄せて確定させる。
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const pre = await armPreload(audio);
    spy.mockRestore();
    expect(pre.src).toBe('https://example.com/ep3.mp3');

    // ランダムをオフにすると確定は破棄され、先読みはリスト順の
    // 次曲 (ep-2) へ張り替わる。
    await toggleShuffleBtn(bar);
    audio.dispatchEvent(new window.Event('timeupdate'));
    await flush();
    expect(pre.src).toBe('https://example.com/ep2.mp3');

    // 終了時は確定していた ep-3 ではなく、リスト順の ep-2 へ進む。
    await endActive(audio);
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
  });

  it('本人が別の曲を選ぶと確定が破棄され、選び直した曲の先読みが新たに始まる', async () => {
    await mountWithEpisodes([{ ...EP1 }, { ...EP2 }, { ...EP3 }]);
    const bar = await startCard(0);
    await toggleShuffleBtn(bar);
    const audio = latestAudio();

    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const pre = await armPreload(audio);
    expect(pre.src).toBe('https://example.com/ep3.mp3');

    // 本人が ep-2 のカードを選ぶと、確定 (ep-3) は破棄され、
    // 先読み側は空に戻る (確定曲へ誤って進まない)。
    el.querySelectorAll('.article-card')[1].querySelector('.play-btn').click();
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(pre.src).toBe('');

    // 再生が始まれば、選び直した曲に対する抽選・先読みが新たに
    // 始まる (候補は未再生の ep-1 / ep-3 で、先頭に寄せる)。
    spy.mockReturnValue(0);
    const rearmed = await armPreload(audio);
    spy.mockRestore();
    expect(rearmed).toBe(pre);
    expect(pre.src).toBe('https://example.com/ep1.mp3');

    await endActive(audio);
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード1');
    expect(pre.paused).toBe(false);
  });

  it('ラウンド内では同じ曲が二重に選ばれず、一巡したら止まる', async () => {
    await mountWithEpisodes([{ ...EP1 }, { ...EP2 }, { ...EP3 }]);
    const bar = await startCard(0);
    await toggleShuffleBtn(bar);
    const audio = latestAudio();

    // 1回目の確定は ep-2 / ep-3 のどちらか (抽選次第)。
    const pre = await armPreload(audio);
    const firstIsEp2 = pre.src === 'https://example.com/ep2.mp3';
    expect(firstIsEp2 || pre.src === 'https://example.com/ep3.mp3').toBe(true);

    // 終了時は確定曲へ役割交代する。
    await endActive(audio);
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe(firstIsEp2 ? 'エピソード2' : 'エピソード3');
    expect(pre.paused).toBe(false);

    // 交代した要素が再生を始めたら、次の確定は残りの未再生
    // (もう一方) になり、待機側は旧アクティブが転用される。
    pre.dispatchEvent(new window.Event('playing'));
    await flush();
    expect(audio.src).toBe(firstIsEp2 ? 'https://example.com/ep3.mp3' : 'https://example.com/ep2.mp3');

    await endActive(pre);
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe(firstIsEp2 ? 'エピソード3' : 'エピソード2');
    expect(audio.paused).toBe(false);

    // 一巡したので (リピートなし) 次へは進まず止まる。
    await endActive(audio);
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe(firstIsEp2 ? 'エピソード3' : 'エピソード2');
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

describe('再生診断ログ', () => {
  // バックグラウンド再生の失敗を後から追うための診断イベント
  // (視聴ログと同じ logEvents 経路)。固定したいのは、各種別が
  // 正しい状況で・正しい曲の文脈で送られることと、送信が既存の
  // 区切りに相乗りする (先読みエラーだけでは送られない) こと。
  const DIAG_TYPES = ['preload_error', 'advance_swap', 'advance_load', 'stall', 'recover'];
  const sentEvents = () => logEvents.mock.calls.flatMap((c) => c[1]);
  const diagEvents = () => sentEvents().filter((e) => DIAG_TYPES.includes(e.type));

  async function fireVisible() {
    document.dispatchEvent(new window.Event('visibilitychange'));
    await flush();
  }

  it('役割交代で進んだら advance_swap が次の曲の文脈で送られる', async () => {
    await mountPlayer();
    await startCard(0);
    const audio = latestAudio();
    // 再生開始で次曲の先読みを始める。
    audio.dispatchEvent(new window.Event('playing'));
    await flush();
    expect(audioInstances.length).toBe(2);

    audio.ended = true;
    audio.paused = true;
    audio.dispatchEvent(new window.Event('ended'));
    await flush();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(diagEvents()).toEqual([
      expect.objectContaining({
        type: 'advance_swap',
        feed_id: FEED_ID,
        feed_title: 'Rebuild',
        article_id: 'ep-2',
        article_title: 'エピソード2',
      }),
    ]);
  });

  it('先読みが無い状態で進んだら advance_load が送られる', async () => {
    await mountPlayer();
    await startCard(0);
    // 'playing' を送らないので先読みは始まらず、従来経路で進む。
    await fireEnded();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(diagEvents()).toEqual([
      expect.objectContaining({ type: 'advance_load', article_id: 'ep-2' }),
    ]);
  });

  it('先読みでエラーが起きたら preload_error が先読み先の文脈で送られる', async () => {
    await mountPlayer();
    await startCard(0);
    const audio = latestAudio();
    audio.dispatchEvent(new window.Event('playing'));
    await flush();
    const pre = audioInstances[audioInstances.length - 1];
    expect(pre.src).toBe('https://example.com/ep2.mp3');

    pre.dispatchEvent(new window.Event('error'));
    await flush();
    expect(errors).toEqual([]);
    // 送信は既存の区切りに相乗りするので、エラーの時点では
    // まだ送られない (キューに残っている)。
    expect(diagEvents()).toEqual([]);

    // 曲が終わって次へ進む区切りで、先に残っていた preload_error
    // と、その遷移の内訳 (読み直した試行での役割交代) が届く。
    audio.ended = true;
    audio.paused = true;
    audio.dispatchEvent(new window.Event('ended'));
    await flush();
    expect(errors).toEqual([]);
    expect(diagEvents()).toEqual([
      expect.objectContaining({ type: 'preload_error', article_id: 'ep-2', article_title: 'エピソード2' }),
      expect.objectContaining({ type: 'advance_swap', article_id: 'ep-2' }),
    ]);
  });

  it('復帰回復で次へ進んだら recover が止まっていた曲の文脈で送られる', async () => {
    await mountPlayer();
    await startCard(0);
    const audio = latestAudio();
    // バックグラウンドで曲が終わったまま止まった状態で復帰する。
    audio.ended = true;
    audio.paused = true;
    await fireVisible();
    expect(errors).toEqual([]);
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    // 遷移の内訳 (advance_load) と、回復の発動 (recover) が
    // 対で残る。recover の対象は止まっていた側の曲。
    expect(diagEvents()).toEqual([
      expect.objectContaining({ type: 'advance_load', article_id: 'ep-2' }),
      expect.objectContaining({ type: 'recover', article_id: 'ep-1', article_title: 'エピソード1' }),
    ]);
  });

  it('復帰回復で再開したら recover がその曲の文脈で送られる', async () => {
    await mountPlayer();
    await startCard(0);
    const audio = latestAudio();
    // 自動送りの play() が NotAllowedError で拒否され、次曲で
    // 止まったままになる状態 (既存の回復テストと同じ作り方)。
    const originalPlay = audio.play.bind(audio);
    audio.play = () => {
      audio.ended = false;
      audio.paused = true;
      const err = new Error('blocked');
      err.name = 'NotAllowedError';
      return Promise.reject(err);
    };
    await fireEnded();
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    audio.play = originalPlay;
    await fireVisible();
    expect(errors).toEqual([]);
    expect(audio.paused).toBe(false);
    expect(diagEvents()).toContainEqual(
      expect.objectContaining({ type: 'recover', article_id: 'ep-2' })
    );
  });

  it('本人が一時停止していたら recover は送られない', async () => {
    await mountPlayer();
    await startCard(0);
    el.querySelectorAll('.article-card')[0].querySelector('.play-btn').click();
    await flush();
    await fireVisible();
    expect(errors).toEqual([]);
    expect(diagEvents().filter((e) => e.type === 'recover')).toEqual([]);
  });
});

describe('待機側の無音保証 (二重再生対策)', () => {
  // 実機で、先読みしていた待機側が鳴って二重再生になる例が
  // 確認された (2026-11-18)。待機側は設計上再生されないため、
  // 再生状態になっているのを見つけたら止めて deck_overlap と
  // して残す (silenceStandbyDeck)。固定したいのは、各地点
  // (タイマーの tick・フォアグラウンド復帰・本人の停止操作) で
  // 待機側だけが止まり、本体の再生と役割交代は壊れないこと。
  const sentEvents = () => logEvents.mock.calls.flatMap((c) => c[1]);
  const overlapEvents = () => sentEvents().filter((e) => e.type === 'deck_overlap');

  // 再生を開始して次曲の先読みまで進め、{ 本体, 待機側 } を返す。
  async function startWithPreload() {
    await mountPlayer();
    await startCard(0);
    const audio = latestAudio();
    audio.dispatchEvent(new window.Event('playing'));
    await flush();
    const pre = audioInstances[audioInstances.length - 1];
    expect(pre, '待機側が作られる').not.toBe(audio);
    expect(pre.src).toBe('https://example.com/ep2.mp3');
    return { audio, pre };
  }

  it('フォアグラウンド復帰で待機側が止まり、deck_overlap が待機側の曲の文脈で送られる', async () => {
    const { audio, pre } = await startWithPreload();
    // 待機側が鳴ってしまった状態を再現する (リスナー側の
    // ガードで本体の状態は変わらない)。
    pre.currentTime = 42;
    pre.play();
    expect(pre.paused).toBe(false);

    document.dispatchEvent(new window.Event('visibilitychange'));
    await flush();
    expect(errors).toEqual([]);
    // 待機側だけが止まり、本体の再生は続く。
    expect(pre.paused).toBe(true);
    expect(audio.paused).toBe(false);
    expect(overlapEvents()).toEqual([
      expect.objectContaining({
        type: 'deck_overlap',
        feed_id: FEED_ID,
        article_id: 'ep-2',
        article_title: 'エピソード2',
        seconds: 42,
      }),
    ]);
  });

  it('再生中のタイマーの tick でも待機側が止まる', async () => {
    const { audio, pre } = await startWithPreload();
    pre.play();
    expect(pre.paused).toBe(false);
    // 終端チェックのタイマー (500ms) の tick を実時間で待つ。
    await new Promise((r) => setTimeout(r, 1200));
    await flush();
    expect(errors).toEqual([]);
    expect(pre.paused).toBe(true);
    // 診断はキューに積まれ、次の区切り (曲の終了時の送信) で
    // 一緒に送られる。終了はアクティブ側へ送る (fireEnded は
    // 最新の要素 = 待機側を対象にしてしまうため使わない)。
    audio.ended = true;
    audio.paused = true;
    audio.dispatchEvent(new window.Event('ended'));
    await flush();
    expect(overlapEvents()).toEqual([
      expect.objectContaining({ type: 'deck_overlap', article_id: 'ep-2' }),
    ]);
  });

  it('本人が一時停止したら待機側も止まる', async () => {
    const { audio, pre } = await startWithPreload();
    pre.play();
    // 再生中エピソードのカードのボタン = 一時停止。
    el.querySelectorAll('.article-card')[0].querySelector('.play-btn').click();
    await flush();
    expect(errors).toEqual([]);
    expect(audio.paused).toBe(true);
    expect(pre.paused).toBe(true);
  });

  it('プレイヤーを閉じたら待機側も止まる', async () => {
    const { pre } = await startWithPreload();
    pre.play();
    el.querySelector('.player-close').click();
    await flush();
    expect(errors).toEqual([]);
    expect(pre.paused).toBe(true);
    expect(el.querySelector('.player-bar')).toBeNull();
  });

  it('待機側を止めた後でも、曲の終了では役割交代で次へ進める', async () => {
    const { audio, pre } = await startWithPreload();
    pre.play();
    document.dispatchEvent(new window.Event('visibilitychange'));
    await flush();
    expect(pre.paused).toBe(true);

    audio.ended = true;
    audio.paused = true;
    audio.dispatchEvent(new window.Event('ended'));
    await flush();
    expect(errors).toEqual([]);
    // 先読み済みの待機側がそのまま昇格して再生される。
    expect(el.querySelector('.player-title').textContent).toBe('エピソード2');
    expect(pre.paused).toBe(false);
    expect(pre.src).toBe('https://example.com/ep2.mp3');
  });

  it('待機側が通常どおり止まっていれば、復帰でも tick でも何も起きない', async () => {
    const { audio, pre } = await startWithPreload();
    document.dispatchEvent(new window.Event('visibilitychange'));
    await flush();
    await new Promise((r) => setTimeout(r, 1200));
    await flush();
    expect(errors).toEqual([]);
    expect(audio.paused).toBe(false);
    expect(pre.paused).toBe(true);
    expect(overlapEvents()).toEqual([]);
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
