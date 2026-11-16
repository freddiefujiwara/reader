// 視聴ログのキューと再生時間トラッカーの単体テスト。
// キュー: 貯めて区切りでまとめて送ること、上限で分割すること、
// 失敗した分は捨てること、送れない状態では貯めないこと。
// トラッカー: play/pause の区間で実再生時間を積算し、一時停止や
// シークに相当する時間は数えないこと、短い再生は捨てること。
import { describe, it, expect, vi } from 'vitest';
import {
  createEventQueue,
  createListenTracker,
  EVENT_LOG_MAX_BATCH,
  PLAY_MIN_SECONDS,
} from '../src/lib/eventLog.js';

const ev = (type, extra = {}) => ({
  type,
  feed_id: 'feed-1',
  feed_title: 'フィード1',
  article_id: '',
  article_title: '',
  ...extra,
});

describe('createEventQueue', () => {
  it('push では送らず、flush で ts を付けてまとめて送る', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const q = createEventQueue({
      send,
      enabled: () => true,
      now: () => '2026-11-17T00:00:00.000Z',
    });
    q.push(ev('feed_view'));
    q.push(ev('article_open', { article_id: 'a1', article_title: '記事1' }));
    expect(send).not.toHaveBeenCalled();
    await q.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual([
      { ts: '2026-11-17T00:00:00.000Z', ...ev('feed_view') },
      { ts: '2026-11-17T00:00:00.000Z', ...ev('article_open', { article_id: 'a1', article_title: '記事1' }) },
    ]);
    expect(q.size()).toBe(0);
  });

  it('空なら flush しても送らない', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const q = createEventQueue({ send, enabled: () => true });
    await q.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('上限件数たまると自動で送り、残りは次の flush で送る', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const q = createEventQueue({ send, enabled: () => true });
    for (let i = 0; i < EVENT_LOG_MAX_BATCH + 3; i += 1) q.push(ev('feed_view'));
    // 上限到達時点で1回送られ、残り3件はキューに残る。
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toHaveLength(EVENT_LOG_MAX_BATCH);
    expect(q.size()).toBe(3);
    // 残りは flush の連鎖で続けて送られる (明示的に flush してもよい)。
    q.flush();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][0]).toHaveLength(3);
    expect(q.size()).toBe(0);
  });

  it('送信に失敗した分は捨て、再送しない', async () => {
    const send = vi.fn(async () => { throw new Error('boom'); });
    const q = createEventQueue({ send, enabled: () => true });
    q.push(ev('feed_view'));
    await q.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(q.size()).toBe(0);
    await q.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('送れない状態 (enabled が false) では flush で捨てる', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const q = createEventQueue({ send, enabled: () => false });
    q.push(ev('feed_view'));
    await q.flush();
    expect(send).not.toHaveBeenCalled();
    expect(q.size()).toBe(0);
  });
});

describe('createListenTracker', () => {
  function setup() {
    let t = 0;
    const tracker = createListenTracker({ now: () => t });
    tracker.setContext({ id: 'ep-1', feedId: 'feed-1', feedTitle: 'フィード1', title: 'エピソード1' });
    return { tracker, advance: (ms) => { t += ms; } };
  }

  it('再生区間の合計を play イベントにする (一時停止の間は数えない)', () => {
    const { tracker, advance } = setup();
    tracker.start();
    advance(10_000);
    tracker.pause();
    advance(60_000); // 一時停止中の時間は数えない
    tracker.start();
    advance(20_000);
    tracker.pause();
    const event = tracker.finalize();
    expect(event).toEqual({
      type: 'play',
      feed_id: 'feed-1',
      feed_title: 'フィード1',
      article_id: 'ep-1',
      article_title: 'エピソード1',
      seconds: 30,
    });
    // finalize で積算はリセットされる (対象は維持)。
    expect(tracker.finalize()).toBeNull();
  });

  it('区間を開いたまま finalize すると、そこまでの時間で確定する', () => {
    const { tracker, advance } = setup();
    tracker.start();
    advance(12_500);
    expect(tracker.finalize().seconds).toBe(12); // 小数部は切り捨て
  });

  it(`${PLAY_MIN_SECONDS}秒未満の再生はイベントにしない`, () => {
    const { tracker, advance } = setup();
    tracker.start();
    advance((PLAY_MIN_SECONDS - 1) * 1000);
    tracker.pause();
    expect(tracker.finalize()).toBeNull();
  });

  it('対象が無い (clear 後) はイベントにしない', () => {
    const { tracker, advance } = setup();
    tracker.start();
    advance(30_000);
    tracker.clear();
    expect(tracker.finalize()).toBeNull();
  });

  it('start の重ね掛けでは二重に数えない', () => {
    const { tracker, advance } = setup();
    tracker.start();
    advance(5_000);
    tracker.start(); // 既に開いている区間は開き直さない
    advance(5_000);
    expect(tracker.finalize().seconds).toBe(10);
  });
});
