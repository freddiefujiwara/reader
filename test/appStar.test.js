// スター制 (App.vue) のコンポーネントテスト。API と取得経路だけを
// モックし、記事は IndexedDB (fake-indexeddb) へ種まきして実際の
// App をマウントする (ハーネスは appPlayer と同じ)。
// 固定したい振る舞い:
// - スターボタンは YouTube フィードの記事にだけ出る (オーナーのみ)。
// - YouTube 記事の再生ボタンは「スター付き＋音声URLあり」のときだけ。
//   ポッドキャストは従来どおり音声URLの有無だけで出る。
// - 付け外しは楽観的に反映され、set_star 失敗で元へ戻る。
// - list 応答のスター状態でローカルが上書き同期される。
// - キュー抽出も再生ボタンと同じ条件に従う (スター無しは飛ばす)。
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

// サーバー (list 応答) が返す記事。スター同期の検証で差し替える。
let serverArticles = [];

const rec = (id, feed_id, title, published_at, extra = {}) => ({
  id,
  feed_id,
  title,
  link: `https://example.com/${id}`,
  published_at,
  fetched_at: '2026-11-15T00:00:00.000Z',
  summary: '',
  author: '',
  audio_url: '',
  audio_url_at: '',
  audio_stale: false,
  duration_sec: 600,
  play_pos: 0,
  is_read: false,
  read_at: '',
  starred: false,
  star_state: '',
  ...extra,
});

// audio_url_at は「最後に新鮮な enclosure を受け取った時刻」で、
// 表示時に6時間を超えると音声なしとして扱われるため、実行時点の
// 時刻を入れる。
const AUDIO = { audio_url: 'https://example.com/audio.m4a', audio_url_at: new Date().toISOString() };

vi.mock('../src/lib/api.js', () => ({
  setStar: vi.fn(async () => ({ ok: true })),
  deleteFeed: vi.fn(async () => ({ ok: true })),
  exchangeSession: vi.fn(async () => ({ ok: true })),
  exchangeShare: vi.fn(async () => ({ ok: true })),
  listArticles: vi.fn(async () => ({
    ok: true,
    feeds: FEEDS.map((f) => ({ ...f })),
    articles: serverArticles.map((a) => ({ ...a })),
  })),
  listFeeds: vi.fn(async () => ({ ok: true, feeds: FEEDS.map((f) => ({ ...f })) })),
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
import { setStar } from '../src/lib/api.js';
import { loadLocalArticles, saveLocalFeeds, putLocalArticles, deleteLocalArticles } from '../src/lib/localDb.js';

// jsdom の HTMLMediaElement は再生を実装しないため、App が使う
// 面だけを持ち、'ended' などをテストから発火できるスタブにする
// (appPlayer と同じ)。
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

// 条件が満たされるまで待つ (固定回数の flush は、並列実行時の負荷で
// 背景更新や IndexedDB 書き込みの完了前に尽きることがあるため、
// 非同期処理の完了を待つ箇所ではこちらを使う)。
const flushUntil = async (cond, maxRounds = 120) => {
  for (let i = 0; i < maxRounds; i += 1) {
    if (await cond()) return true;
    await flushRound();
  }
  return !!(await cond());
};

const latestAudio = () => audioInstances[audioInstances.length - 1];

async function mountApp(records) {
  await saveLocalFeeds(FEEDS.map((f) => ({ ...f })));
  await putLocalArticles(records);
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp(App);
  app.config.errorHandler = (err) => { errors.push(err); };
  app.mount(el);
  await flush();
  // 起動時の読み直しでカードが描画されるまで待つ。
  await flushUntil(() => el.querySelectorAll('.article-card').length > 0);
  expect(errors).toEqual([]);
}

const cardByTitle = (title) =>
  [...el.querySelectorAll('.article-card')].find(
    (c) => c.querySelector('.article-title').textContent === title
  );

const localRow = async (id) => (await loadLocalArticles()).find((a) => a.id === id);

beforeEach(async () => {
  errors = [];
  serverArticles = [];
  audioInstances.length = 0;
  document.body.innerHTML = '';
  // IndexedDB はファイル内で共有されるため、前テストの記事を消す。
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

describe('スターと再生ボタンの表示', () => {
  it('YouTube 記事にだけスターボタンが出て、再生ボタンはスター付きのときだけ出る', async () => {
    await mountApp([
      rec('yt-starred', YT_FEED_ID, 'スター付き動画', '2026-11-15T00:00:00.000Z', { ...AUDIO, starred: true }),
      rec('yt-plain', YT_FEED_ID, 'スター無し動画', '2026-11-14T00:00:00.000Z', { ...AUDIO }),
      rec('pod-1', POD_FEED_ID, 'ポッドキャスト', '2026-11-13T00:00:00.000Z', { ...AUDIO }),
    ]);

    const starred = cardByTitle('スター付き動画');
    expect(starred.querySelector('.star-btn'), 'スター付きにはスターボタン').toBeTruthy();
    expect(starred.querySelector('.star-btn').textContent).toBe('⭐');
    expect(starred.querySelector('.star-btn').getAttribute('aria-label')).toBe('スターを外す');
    expect(starred.querySelector('.play-btn'), 'スター付きには再生ボタン').toBeTruthy();

    const plain = cardByTitle('スター無し動画');
    expect(plain.querySelector('.star-btn').textContent).toBe('☆');
    expect(plain.querySelector('.star-btn').getAttribute('aria-label')).toBe('スターを付ける');
    expect(plain.querySelector('.play-btn'), 'スター無しの YouTube 記事に再生ボタンは出ない').toBeNull();

    const pod = cardByTitle('ポッドキャスト');
    expect(pod.querySelector('.star-btn'), 'ポッドキャストにスターボタンは出ない').toBeNull();
    expect(pod.querySelector('.play-btn'), 'ポッドキャストは従来どおり再生ボタンが出る').toBeTruthy();
  });
});

describe('スターボタンの位置', () => {
  it('スターはアクション行の左端に固定され、再生ボタンより前に出る', async () => {
    await mountApp([
      rec('yt-starred', YT_FEED_ID, 'スター付き動画', '2026-11-15T00:00:00.000Z', { ...AUDIO, starred: true }),
      rec('yt-plain', YT_FEED_ID, 'スター無し動画', '2026-11-14T00:00:00.000Z', { ...AUDIO }),
    ]);

    // 再生できる (スター付き) カード: 先頭がスター、その後に再生ボタン。
    const starredFoot = cardByTitle('スター付き動画').querySelector('.article-foot');
    expect(starredFoot.firstElementChild.classList.contains('star-btn'), '左端がスター').toBe(true);
    const starIdx = [...starredFoot.children].findIndex((c) => c.classList.contains('star-btn'));
    const playIdx = [...starredFoot.children].findIndex((c) => c.classList.contains('play-btn'));
    expect(playIdx, '再生ボタンがある').toBeGreaterThanOrEqual(0);
    expect(starIdx, 'スターが再生ボタンより前 (左)').toBeLessThan(playIdx);

    // 再生できない (スター無し) カードでも、スターは同じ左端に出る。
    const plainFoot = cardByTitle('スター無し動画').querySelector('.article-foot');
    expect(plainFoot.querySelector('.play-btn')).toBeNull();
    expect(plainFoot.firstElementChild.classList.contains('star-btn'), '再生不可でも左端がスター').toBe(true);
  });

  it('スターを外して再生ボタンが消えても、スターは左端のまま動かない', async () => {
    await mountApp([
      rec('yt-on', YT_FEED_ID, '再生できる動画', '2026-11-15T00:00:00.000Z', { ...AUDIO, starred: true }),
    ]);
    const footBefore = cardByTitle('再生できる動画').querySelector('.article-foot');
    expect(footBefore.firstElementChild.classList.contains('star-btn')).toBe(true);

    cardByTitle('再生できる動画').querySelector('.star-btn').click();
    await flushUntil(async () =>
      setStar.mock.calls.length >= 1 && (await localRow('yt-on'))?.star_state === 'off');

    const card = cardByTitle('再生できる動画');
    expect(card.querySelector('.play-btn'), '再生ボタンは消える').toBeNull();
    const footAfter = card.querySelector('.article-foot');
    expect(footAfter.firstElementChild.classList.contains('star-btn'), '外した後も左端がスター').toBe(true);
    expect(footAfter.firstElementChild.textContent).toBe('☆');
  });
});

describe('スターの付け外し', () => {
  it('付けると set_star が呼ばれて点灯し、DB に手動の印が残る (音声URLが無ければボタンは出ない)', async () => {
    await mountApp([
      rec('yt-new', YT_FEED_ID, '新しい動画', '2026-11-15T00:00:00.000Z'),
    ]);
    const card = cardByTitle('新しい動画');
    card.querySelector('.star-btn').click();
    // 楽観的な DB 書き込みと set_star の送信が済むまで待つ。
    await flushUntil(async () =>
      setStar.mock.calls.length >= 1 && (await localRow('yt-new'))?.star_state === 'on');

    expect(errors).toEqual([]);
    expect(setStar).toHaveBeenCalledWith('tok', 'yt-new', true);
    expect(cardByTitle('新しい動画').querySelector('.star-btn').textContent).toBe('⭐');
    // 音声URLはまだ無い (抽出待ち) ので、再生ボタンは出ない。
    expect(cardByTitle('新しい動画').querySelector('.play-btn')).toBeNull();
    const row = await localRow('yt-new');
    expect(row.starred).toBe(true);
    expect(row.star_state).toBe('on');
  });

  it('外すと再生ボタンがその場で消え、DB に外した印が残る (音声URLは残る)', async () => {
    await mountApp([
      rec('yt-on', YT_FEED_ID, '再生できる動画', '2026-11-15T00:00:00.000Z', { ...AUDIO, starred: true }),
    ]);
    expect(cardByTitle('再生できる動画').querySelector('.play-btn')).toBeTruthy();
    cardByTitle('再生できる動画').querySelector('.star-btn').click();
    // 楽観的な DB 書き込みと set_star の送信が済むまで待つ。
    await flushUntil(async () =>
      setStar.mock.calls.length >= 1 && (await localRow('yt-on'))?.star_state === 'off');

    expect(errors).toEqual([]);
    expect(setStar).toHaveBeenCalledWith('tok', 'yt-on', false);
    const card = cardByTitle('再生できる動画');
    expect(card.querySelector('.star-btn').textContent).toBe('☆');
    expect(card.querySelector('.play-btn'), '外した瞬間に再生ボタンが消える').toBeNull();
    const row = await localRow('yt-on');
    expect(row.starred).toBe(false);
    expect(row.star_state).toBe('off');
    expect(row.audio_url, '音声URL自体はローカルに残る').toBe(AUDIO.audio_url);
  });

  it('set_star が失敗したら、表示も DB も元の状態へ戻る', async () => {
    setStar.mockRejectedValueOnce(new Error('forbidden'));
    await mountApp([
      rec('yt-on', YT_FEED_ID, '再生できる動画', '2026-11-15T00:00:00.000Z', { ...AUDIO, starred: true }),
    ]);
    cardByTitle('再生できる動画').querySelector('.star-btn').click();
    // 失敗の処理 (DB の巻き戻し→エラー表示) が終わるまで待つ。
    // エラー表示は巻き戻しの DB 書き込みの後に立つので、「再試行」の
    // 出現が処理完了の目印になる。
    const findRetry = () =>
      [...el.querySelectorAll('button')].find((b) => b.textContent.includes('再試行'));
    await flushUntil(() => !!findRetry());

    expect(errors).toEqual([]);
    // 失敗時はエラー表示になり (既存の作法)、DB は元の状態へ戻る。
    const row = await localRow('yt-on');
    expect(row.starred).toBe(true);
    expect(row.star_state).toBe('');
    // エラーパネルの「再試行」で一覧に戻ると、表示も元のまま。
    const retry = findRetry();
    expect(retry, '再試行ボタンが出る').toBeTruthy();
    retry.click();
    await flushUntil(() => {
      const c = cardByTitle('再生できる動画');
      return !!c?.querySelector('.play-btn')
        && c.querySelector('.star-btn')?.textContent === '⭐';
    });
    const card = cardByTitle('再生できる動画');
    expect(card.querySelector('.star-btn').textContent, 'スターは点いたまま').toBe('⭐');
    expect(card.querySelector('.play-btn'), '再生ボタンも残る').toBeTruthy();
  });
});

describe('スター状態の同期 (list 応答が正本)', () => {
  it('サーバー側で付いたスターが、更新でローカルへ反映されて再生ボタンが出る', async () => {
    serverArticles = [{ id: 'yt-sync', starred: true, star_state: 'on' }];
    await mountApp([
      rec('yt-sync', YT_FEED_ID, '同期される動画', '2026-11-15T00:00:00.000Z', { ...AUDIO }),
    ]);
    // 起動時の背景更新でスター同期が DB と表示へ届くまで待つ。
    await flushUntil(async () =>
      (await localRow('yt-sync'))?.starred === true
      && cardByTitle('同期される動画')?.querySelector('.star-btn')?.textContent === '⭐');
    const card = cardByTitle('同期される動画');
    expect(card.querySelector('.star-btn').textContent).toBe('⭐');
    expect(card.querySelector('.play-btn'), '同期後は再生ボタンが出る').toBeTruthy();
    const row = await localRow('yt-sync');
    expect(row.starred).toBe(true);
    expect(row.star_state).toBe('on');
  });
});

describe('キューの抽出もスター条件に従う', () => {
  it('自動送りはスター無しの YouTube 記事を飛ばす', async () => {
    await mountApp([
      rec('yt-a', YT_FEED_ID, '動画A', '2026-11-15T00:00:00.000Z', { ...AUDIO, starred: true }),
      rec('yt-b', YT_FEED_ID, '動画B', '2026-11-14T00:00:00.000Z', { ...AUDIO }),
      rec('yt-c', YT_FEED_ID, '動画C', '2026-11-13T00:00:00.000Z', { ...AUDIO, starred: true }),
    ]);
    cardByTitle('動画A').querySelector('.play-btn').click();
    await flushUntil(() => el.querySelector('.player-title')?.textContent === '動画A');
    expect(el.querySelector('.player-title').textContent).toBe('動画A');

    const audio = latestAudio();
    audio.ended = true;
    audio.paused = true;
    audio.dispatchEvent(new window.Event('ended'));
    await flushUntil(() => el.querySelector('.player-title')?.textContent === '動画C');
    expect(errors).toEqual([]);
    // B はスター無しなので、次は C になる。
    expect(el.querySelector('.player-title').textContent).toBe('動画C');
  });
});

describe('readonly セッション', () => {
  it('スターボタンは出ない (再生ボタンは従来どおり)', async () => {
    localStorage.setItem(
      'reader:session:v1',
      JSON.stringify({ token: 'tok-readonly', role: 'readonly', expiresAt: null })
    );
    await mountApp([
      rec('yt-ro', YT_FEED_ID, '共有で見る動画', '2026-11-15T00:00:00.000Z', { ...AUDIO, starred: true }),
    ]);
    const card = cardByTitle('共有で見る動画');
    expect(card.querySelector('.star-btn')).toBeNull();
    expect(card.querySelector('.play-btn')).toBeTruthy();
    expect(setStar).not.toHaveBeenCalled();
  });
});
