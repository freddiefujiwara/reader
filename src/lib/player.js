// ポッドキャストプレイヤーの純粋な補助関数 (DOM / Audio 要素の操作は
// App.vue 側)。時間表示の形は blog のプレイヤー (musicPlayer.js の
// formatTime) に揃え、1時間以上のエピソードだけ H:MM:SS にする。
import { isStagingBuild } from '../staging-banner.js';

export const SPEEDS = [1, 1.25, 1.5, 2];

// 秒 → "M:SS" (1時間以上は "H:MM:SS")。NaN や負数は "0:00"。
export function formatTime(sec) {
  const total = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const seconds = String(total % 60).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  if (hours > 0) {
    const minutes = String(Math.floor(total / 60) % 60).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }
  return `${Math.floor(total / 60)}:${seconds}`;
}

// 再生速度の循環: 1 → 1.25 → 1.5 → 2 → 1。未知の値は先頭 (1) へ。
export function nextSpeed(current) {
  const idx = SPEEDS.indexOf(current);
  return SPEEDS[(idx + 1) % SPEEDS.length];
}

// シーク先を [0, duration] へ丸める。duration が不明なら下限だけ守る。
export function clampSeek(sec, duration) {
  const value = Number.isFinite(sec) ? sec : 0;
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, value);
  return Math.min(Math.max(0, value), duration);
}

// 進み具合 (0..1)。duration が不明・ゼロなら 0。
export function progressRatio(current, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (!Number.isFinite(current) || current <= 0) return 0;
  return Math.min(1, current / duration);
}

/* ---- 再生モード (blog の musicPlayer と同じ語彙・遷移) ---- */

// リピートの3状態と表示名・遷移。モードの組み立ては blog と同じ:
// 連続再生 = ランダム off + リピートなし、ランダム再生 = ランダム on、
// 全体繰り返し = リピート全曲、単曲繰り返し = リピート1曲。
export const REPEAT_LABELS = { none: 'リピート：なし', all: 'リピート：全曲', one: 'リピート：1曲' };
export const REPEAT_CYCLE = { none: 'all', all: 'one', one: 'none' };

export function nextRepeat(current) {
  return REPEAT_CYCLE[current] || 'none';
}

// 再生開始時点の表示リスト (フィルタ適用後) から、開始エピソードと
// 同じフィードの音声つき記事だけを表示順のまま抜き出したキュー。
// 開始エピソードがリストに無ければ、その1件だけのキューにする。
// 呼び出し側はこの結果をスナップショットとして保持し、再生中の
// 既読化などで表示が変わっても並びを変えない。
export function buildQueue(articles, current) {
  if (!current) return [];
  const list = Array.isArray(articles) ? articles : [];
  const queue = list.filter((a) => a && a.feedId === current.feedId && a.audioUrl);
  if (!queue.some((a) => a.id === current.id)) return [current];
  return queue;
}

// 1件終わったときの次手。blog の endedPlan と同じ規則を記事IDで表す。
//   repeat 'one' → replay (同じエピソードを先頭から)
//   shuffle      → このラウンドで未再生のものから randomPick で1件。
//                  残りが無ければ、全体繰り返しのときだけラウンドを
//                  やり直す (resetPlayed。今のエピソードは、他にも
//                  候補がある間は引き直しの対象にしない)
//   list order   → 次の1件。末尾では全体繰り返しなら先頭へ、
//                  それ以外は stop
// randomPick は候補の配列を受け取り1件返す関数 (テストで差し替える)。
export function nextEpisodePlan({ queue, currentId, repeat = 'none', shuffle = false, playedIds, randomPick } = {}) {
  const ids = Array.isArray(queue) ? queue : [];
  if (!ids.length) return { type: 'stop' };
  if (repeat === 'one') return { type: 'replay' };
  const played = playedIds instanceof Set ? playedIds : new Set(playedIds || []);
  const pick = typeof randomPick === 'function'
    ? randomPick
    : (candidates) => candidates[Math.floor(Math.random() * candidates.length)];
  if (shuffle) {
    const remaining = ids.filter((id) => id !== currentId && !played.has(id));
    if (remaining.length) return { type: 'advance', id: pick(remaining) };
    if (repeat === 'all') {
      const fresh = ids.filter((id) => ids.length === 1 || id !== currentId);
      return { type: 'advance', id: pick(fresh), resetPlayed: true };
    }
    return { type: 'stop' };
  }
  const index = ids.indexOf(currentId);
  if (index < 0) return { type: 'stop' };
  if (index + 1 < ids.length) return { type: 'advance', id: ids[index + 1] };
  if (repeat === 'all') return { type: 'advance', id: ids[0] };
  return { type: 'stop' };
}

/* ---- YouTube 音声の再生時間の二重化への対処 ----
   itag 140 の fMP4 は、長さの情報が init セグメントの mvhd と断片側の
   両方に入っており、iOS のプレイヤーが合算して実長の2倍を duration と
   して返すことがある (実測: 104秒の曲が 208秒と報告された)。RSS の
   itunes:duration (durationSec) が正しい長さなので、要素の報告と
   20% 超ずれたら durationSec を正として表示・シークを補正する。
   要素の currentTime の進み方は端末で測るまで分からないため2モデル:
     'direct' … currentTime は実メディアの速さで進む (duration だけ二重)
     'scaled' … currentTime も二重化した時間軸の上を進む (半分の速さ)
   実測したモデルは端末に保存し、次のエピソードの既定にする。 */

// 要素の duration が、既知の正しい長さ (durationSec) と 20% 超ずれて
// いるか。どちらか不明なら false (従来どおり要素を信じる)。
export function durationMismatch(trueSec, elementDuration) {
  if (!Number.isFinite(trueSec) || trueSec <= 0) return false;
  if (!Number.isFinite(elementDuration) || elementDuration <= 0) return false;
  return Math.abs(elementDuration - trueSec) / trueSec > 0.2;
}

// 実測レート (ΔcurrentTime ÷ (Δ実時間 × 再生速度)) からモデルを判定。
// 1.5 超なら時間軸ごと伸びている 'scaled'、0.5〜1.5 なら 'direct'。
// それ以外 (ほぼ止まっている等) は判定不能として null。
export function classifyRate(rate) {
  if (!Number.isFinite(rate)) return null;
  if (rate > 1.5) return 'scaled';
  if (rate >= 0.5) return 'direct';
  return null;
}

// 補正の文脈: { trueSec, elementDuration, model }。model が無ければ
// 補正しない (恒等) ので、通常のポッドキャストは従来どおりになる。
function mappingActive(ctx) {
  return !!ctx && (ctx.model === 'direct' || ctx.model === 'scaled')
    && durationMismatch(ctx.trueSec, ctx.elementDuration);
}

// 要素の currentTime → 表示 (正しい長さ基準) の位置。
export function toDisplayPosition(elementPos, ctx) {
  const pos = Number.isFinite(elementPos) ? elementPos : 0;
  if (!mappingActive(ctx)) return pos;
  if (ctx.model === 'direct') return Math.min(Math.max(0, pos), ctx.trueSec);
  return Math.min(Math.max(0, pos * (ctx.trueSec / ctx.elementDuration)), ctx.trueSec);
}

// 表示位置 (シークバーの値・保存する再開位置) → 要素の currentTime。
export function toElementPosition(displayPos, ctx) {
  const pos = Number.isFinite(displayPos) ? displayPos : 0;
  if (!mappingActive(ctx)) return pos;
  if (ctx.model === 'direct') return Math.min(Math.max(0, pos), ctx.trueSec);
  return Math.min(Math.max(0, pos * (ctx.elementDuration / ctx.trueSec)), ctx.elementDuration);
}

// 終端間際 (残りこの秒数以内) の位置は「聴き終えた」ものとして扱い、
// 再開位置として保存・復元しない。終端付近の保存値が残っていると、
// 次回の再生開始直後に表示位置ベースの終了判定へ入って、既読化と
// 自動送りが連鎖してしまうため。
export const RESUME_END_GUARD_SEC = 5;

// 位置 pos が、全体 totalSec の終端間際 (残り RESUME_END_GUARD_SEC 秒
// 以内) にあるか。長さ不明・位置が 0 以下なら false。
export function isWithinEndGuard(pos, totalSec) {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return false;
  if (!Number.isFinite(pos) || pos <= 0) return false;
  return pos >= totalSec - RESUME_END_GUARD_SEC;
}

// 保存済み再開位置の解釈。旧バージョンは要素スケールで保存していた
// ため、補正が効いているエピソードで正しい長さを超える値は、要素
// スケールの値とみなして比率で割り戻す。新しく保存する値は正しい
// 長さ基準なので trueSec 以下に収まり、そのまま通る。ただし割り戻し
// 後の値も含め、終端間際の値は再開位置として使わず 0 を返す (端末に
// 残っている既存の終端付近の保存値もこれで無力化される)。
export function interpretStoredPlayPos(stored, ctx) {
  const pos = Number.isFinite(stored) && stored > 0 ? stored : 0;
  if (!ctx || !Number.isFinite(ctx.trueSec) || ctx.trueSec <= 0) return pos;
  let result = pos;
  if (durationMismatch(ctx.trueSec, ctx.elementDuration) && pos > ctx.trueSec) {
    result = pos * (ctx.trueSec / ctx.elementDuration);
  }
  if (result <= ctx.trueSec && isWithinEndGuard(result, ctx.trueSec)) return 0;
  return result;
}

// 終端とみなす許容誤差 (秒)。表示位置が全体の残りこの秒数以内に
// 入ったら、実質の終端に達したものとする。
export const TRUE_END_TOLERANCE_SEC = 0.3;

// 表示位置が実質の終端 (残り TRUE_END_TOLERANCE_SEC 秒以内) に
// 達したか。要素の 'ended' が来ないケースで終了フローへ進める
// ための判定。
export function reachedTrueEnd(displayPos, trueSec) {
  if (!Number.isFinite(trueSec) || trueSec <= 0) return false;
  if (!Number.isFinite(displayPos)) return false;
  return displayPos >= trueSec - TRUE_END_TOLERANCE_SEC;
}

/* ---- 既知の長さ (durationSec) への到達による終了判定 ----
   YouTube 曲の durationSec は、reader-gas が抽出時に実ストリーム
   から測った長さであり、発行者の申告ではない。これまでの実機
   でもメディアの実長と一致し (121秒・80秒・49秒など)、表示位置
   も毎回正しく終端まで到達している。一方、要素の 'ended' は
   iOS 上の googlevideo 由来 fMP4 では来ないことがあり、従来の
   表示位置ベースの判定は要素 duration との不一致がある曲に
   限られていたため、両者が一致する通常の曲では 'ended' だけが
   頼りになり、終端で数十秒止まることがあった。そこで、
   durationSec が判明している曲では、表示位置がその長さに
   達した時点で終了とみなす。最後のコンマ数秒が実際の終わり
   より手前に判定される可能性は、許容誤差
   (TRUE_END_TOLERANCE_SEC) の範囲に限られる。
   要素 duration と一致する曲では、表示位置は要素の位置そのもの
   (モデル変換を通らない) なので実測モデルは要らない。ずれて
   いる曲の表示位置はモデル変換を通るため、従来どおり、この曲
   の再生中に実測したモデルがある場合に限る (端末保存の
   learned の流用だけでは発火しない。PR #45 の防御)。 */
export function reachedKnownDurationEnd({ displayPos, trueSec, elementDuration, hasMeasuredModel } = {}) {
  if (!reachedTrueEnd(displayPos, trueSec)) return false;
  if (!durationMismatch(trueSec, elementDuration)) return true;
  return hasMeasuredModel === true;
}

/* ---- 終端停滞の検出 (ウォッチドッグ) ----
   iOS Safari が fMP4 の終端で 'ended' を発火しないことがある。その
   場合は timeupdate 自体も止まるため、reachedTrueEnd のような
   timeupdate 駆動の判定は届かない。インターバル駆動の監視 (App.vue
   側) が要素の currentTime の進みを数え、終端付近で止まったままなら
   終了とみなす。判定材料はこの純粋関数に寄せる。 */

// ウォッチドッグの監視間隔 (ミリ秒)。バッファ基準の経路が駐留から
// 約1秒で発火できるよう、1秒より細かく刻む。表示位置ベースの経路の
// 判定は実時間 (秒) で行うため、間隔を細かくしても意味は変わらない。
export const END_STALL_WATCH_INTERVAL_MS = 500;
// 表示位置が実効終端の残りこの秒数以内にあれば「終端付近」。
// 終端の少し手前で駐留するケースも拾うため余裕を持たせている
// (通常再生の最終数秒は位置が進み続けるので誤発火しない)。
export const END_STALL_WINDOW_SEC = 5;
// 監視1回 (tick) あたりの前進がこの秒数未満なら「前進していない」
// とみなす。終端で止まった要素の報告値のわずかな揺れや、実時間
// よりはるかに遅い微小な前進を、進みとして数えないための下限。
export const END_STALL_PROGRESS_EPSILON_SEC = 0.05;
// 「前進していない」状態がこの秒数以上続いたら「停滞」。
// 監視間隔が 0.5 秒のため、実際の検出は駐留から約1〜1.5秒になる。
export const END_STALL_FROZEN_SEC = 1;

// 終端付近に駐留し、「前進していない」状態が END_STALL_FROZEN_SEC
// 秒以上続いているか。frozenForSec は App.vue 側のウォッチドッグが
// 数えた「tick ごとの前進が END_STALL_PROGRESS_EPSILON_SEC 未満
// だった時間」。実効終端 (effectiveDuration) は表示スケールの
// 全長 (表示位置と同じスケールで渡す)。長さ不明・位置が 0 以下・
// 停滞時間が不明なら false (従来どおり 'ended' を待つ)。
export function isEndStalled(displayPos, effectiveDuration, frozenForSec) {
  if (!Number.isFinite(effectiveDuration) || effectiveDuration <= 0) return false;
  if (!Number.isFinite(displayPos) || displayPos <= 0) return false;
  if (!Number.isFinite(frozenForSec)) return false;
  return displayPos >= effectiveDuration - END_STALL_WINDOW_SEC
    && frozenForSec >= END_STALL_FROZEN_SEC;
}

/* ---- 終端停滞の検出 (バッファ基準) ----
   表示位置ベースの判定は、実機では終端駐留が数十秒続くケースを
   捕まえきれなかった (PR #48 まで調整を重ねても再現が続いた)。
   こちらは要素自身のタイムラインだけで完結する判定: メディア全体
   がダウンロード済み (buffered の最終区間の end が duration の
   間際まで届いている) で、再生位置がその末尾にいて、約1秒の
   正味前進がほぼ無いなら、残りのデータはもう来ないのだから
   終端で止まっているとみなす。表示位置・時間モデル・durationSec
   には一切依存しない。全量バッファされていない場合 (大容量の
   ポッドキャストや低速回線) はこの判定は決して真にならず、
   'ended' イベントと表示位置ベースの判定が受け持つ。 */

// buffered の最終区間の end が duration の残りこの秒数以内まで
// 届いていれば「全量バッファ済み」とみなす。
export const END_BUFFER_TAIL_GAP_SEC = 0.5;
// currentTime が buffered の末尾の残りこの秒数以内にあれば
// 「データの末尾にいる」とみなす。
export const END_BUFFER_NEAR_SEC = 0.5;
// 正味前進を測るルックバックの幅 (秒)。監視間隔 0.5 秒と合わせ、
// 駐留から約1秒 (最大でも 1.5 秒程度) で発火する。
export const END_BUFFER_LOOKBACK_SEC = 1;
// ルックバック幅での前進がこの秒数未満なら「停滞」。終端付近で
// currentTime が微振動しても、正味前進はほぼ 0 になるため、
// tick ごとのリセット方式と違って誤って数え直しにならない。
export const END_BUFFER_MIN_PROGRESS_SEC = 0.1;

// TimeRanges (audio.buffered) の最終区間の end。区間が無い・
// 値が不正なら null。
export function lastBufferedEnd(buffered) {
  if (!buffered || !Number.isFinite(buffered.length) || buffered.length <= 0) return null;
  try {
    const end = buffered.end(buffered.length - 1);
    return Number.isFinite(end) ? end : null;
  } catch {
    return null;
  }
}

// バッファ基準で終端に停滞しているか。progress は約
// END_BUFFER_LOOKBACK_SEC 秒前の位置との差 (正味前進量) で、
// 呼び出し側 (App.vue のウォッチドッグ) がサンプルから求める。
// 条件が1つでも欠ければ false。
export function isBufferedEndStalled({ duration, bufferedEnd, currentTime, progress } = {}) {
  if (!Number.isFinite(duration) || duration <= 0) return false;
  if (!Number.isFinite(bufferedEnd)) return false;
  if (bufferedEnd < duration - END_BUFFER_TAIL_GAP_SEC) return false;
  if (!Number.isFinite(currentTime) || currentTime < bufferedEnd - END_BUFFER_NEAR_SEC) return false;
  if (!Number.isFinite(progress)) return false;
  return progress < END_BUFFER_MIN_PROGRESS_SEC;
}

/* ---- 次の曲の先読み ---- */
// 再生中の曲の残りがこの秒数以下になったら、次に再生することが
// 確定している曲の読み込みを2つ目の要素で温め始める (App.vue
// 側)。曲の開始直後から読み込むとデータ消費が増えるため、
// 終盤に限る。
export const PRELOAD_REMAINING_SEC = 60;

/* ---- 再生モードの端末保存 (セッションキーと同じ環境分け) ---- */

export function playModeKey(env) {
  return isStagingBuild(env) ? 'reader:player-mode:v1:staging' : 'reader:player-mode:v1';
}

export const DEFAULT_PLAY_MODE = { shuffle: false, repeat: 'none' };

function sanePlayMode(value) {
  return {
    shuffle: value?.shuffle === true,
    repeat: REPEAT_CYCLE[value?.repeat] ? value.repeat : 'none',
  };
}

export function loadPlayMode(storage = localStorage, env) {
  try {
    const raw = storage.getItem(playModeKey(env));
    if (!raw) return { ...DEFAULT_PLAY_MODE };
    return sanePlayMode(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PLAY_MODE };
  }
}

export function savePlayMode(mode, storage = localStorage, env) {
  try {
    storage.setItem(playModeKey(env), JSON.stringify(sanePlayMode(mode)));
  } catch {
    // 保存できなくても、その場の再生モード自体は使える。
  }
}

/* ---- 実測した時間モデル ('direct' | 'scaled') の端末保存 ---- */

export function timeModelKey(env) {
  return isStagingBuild(env) ? 'reader:player-timemodel:v1:staging' : 'reader:player-timemodel:v1';
}

// 保存済みのモデル。未測定・壊れた値は null (その場で測り直す)。
export function loadTimeModel(storage = localStorage, env) {
  try {
    const value = storage.getItem(timeModelKey(env));
    return value === 'direct' || value === 'scaled' ? value : null;
  } catch {
    return null;
  }
}

export function saveTimeModel(model, storage = localStorage, env) {
  if (model !== 'direct' && model !== 'scaled') return;
  try {
    storage.setItem(timeModelKey(env), model);
  } catch {
    // 保存できなくても、その場の補正自体は使える。
  }
}
