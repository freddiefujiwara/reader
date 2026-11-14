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
