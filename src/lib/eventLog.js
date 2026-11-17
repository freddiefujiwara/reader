// 視聴ログ (feed_view / article_open / play / scroll / expand) の
// クライアント側の受け皿。イベントはメモリ上のキューに貯め、操作の区切りで
// まとめて送る。送信に失敗した分は捨てる (視聴ログのために
// 再送やリトライで通信を増やさない)。

// サーバー側 (reader-gas の log_events) の1リクエスト上限に合わせる。
export const EVENT_LOG_MAX_BATCH = 50;
// これ未満の再生は誤タップとして play イベントにしない。
export const PLAY_MIN_SECONDS = 5;

// イベントキュー。send は (events) => Promise、enabled は送信して
// よい状態か (オーナーセッションがあるか) を返す関数。
export function createEventQueue({ send, enabled, now = () => new Date().toISOString() }) {
  let queue = [];
  let flushing = false;

  async function flush() {
    if (flushing || !queue.length) return;
    if (!enabled()) {
      // 送れない状態 (未ログイン・読み取り専用) の分は貯めずに捨てる。
      queue = [];
      return;
    }
    const batch = queue.slice(0, EVENT_LOG_MAX_BATCH);
    queue = queue.slice(batch.length);
    flushing = true;
    try {
      await send(batch);
    } catch {
      // 届かなかった分は捨てる。
    } finally {
      flushing = false;
    }
    // 上限で切り分けた残りがあれば続けて送る。
    if (queue.length) flush();
  }

  function push(event) {
    queue.push({ ts: now(), ...event });
    if (queue.length >= EVENT_LOG_MAX_BATCH) flush();
  }

  return {
    push,
    flush,
    size: () => queue.length,
    clear: () => { queue = []; },
  };
}

// 再生の実時間を区間で積算するトラッカー。start で区間を開き、
// pause で閉じる。壁時計の差分で測るため、シーク (位置の移動) は
// 実時間に影響せず、一時停止の間も数えない。再生速度を上げても
// 「実際に再生していた時間」は壁時計どおりになる。
export function createListenTracker({ now = () => performance.now() } = {}) {
  let ctx = null;
  let accumulatedMs = 0;
  let segmentStart = null;

  function closeSegment() {
    if (segmentStart === null) return;
    accumulatedMs += Math.max(0, now() - segmentStart);
    segmentStart = null;
  }

  return {
    // 計測対象のエピソードを差し替える (loadEpisode で前の曲の
    // finalize を済ませてから呼ぶ)。
    setContext(next) {
      ctx = next || null;
    },
    context() {
      return ctx;
    },
    start() {
      if (segmentStart === null) segmentStart = now();
    },
    pause() {
      closeSegment();
    },
    // 区間を閉じて積算を確定する。PLAY_MIN_SECONDS 以上の再生が
    // あれば play イベント (ts はキュー側で付ける) を返し、
    // 無ければ null。積算はリセットするが対象 (ctx) は維持する
    // (単曲リピートで同じ曲を1周ごとに数え直すため)。
    finalize() {
      closeSegment();
      const seconds = accumulatedMs / 1000;
      accumulatedMs = 0;
      if (!ctx || seconds < PLAY_MIN_SECONDS) return null;
      return {
        type: 'play',
        feed_id: ctx.feedId,
        feed_title: ctx.feedTitle || '',
        article_id: ctx.id,
        article_title: ctx.title || '',
        seconds: Math.floor(seconds),
      };
    },
    clear() {
      ctx = null;
      accumulatedMs = 0;
      segmentStart = null;
    },
  };
}
