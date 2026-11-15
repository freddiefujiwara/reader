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
//
// 「リピートOFF／ON」の言い方との対応 (2026-11-15 の仕様確認で固定):
//   OFF = リピートなし (連続再生)。1件終わるごとにキューの次へ進み、
//         末尾まで再生したら停止する (ループしない)。
//   ON  = 全体繰り返し (連続再生＋ループ)。末尾まで再生したら
//         先頭に戻って続ける。
// ランダムと単曲繰り返しは、この OFF／ON の言い方の対象外で、
// 従来どおりの挙動 (下記 nextEpisodePlan の規則) を保つ。
// なお実装は当初からこの対応どおりであり、「OFF = 1件だけ再生
// して終了」にはなっていない (nextEpisodePlan がリピートなしでも
// 次へ進めるため)。
export const REPEAT_LABELS = { none: 'リピート：なし', all: 'リピート：全曲', one: 'リピート：1曲' };
export const REPEAT_CYCLE = { none: 'all', all: 'one', one: 'none' };

export function nextRepeat(current) {
  return REPEAT_CYCLE[current] || 'none';
}

// 再生開始時点の表示リスト (ジャンル・チャンネル・既読状態の絞り込み
// 適用後) から、音声つき記事だけを表示順のまま抜き出したキュー。
// 絞り込みは表示リスト側 (visibleArticles) が担うので、ここでは
// フィードを問わず、再生ボタンの表示条件と同じ audioUrl の有無だけで
// 選ぶ。開始エピソードがリストに無ければ、その1件だけのキューにする。
// 呼び出し側はこの結果をスナップショットとして保持し、再生中の
// 既読化などで表示が変わっても並びを変えない。
export function buildQueue(articles, current) {
  if (!current) return [];
  const list = Array.isArray(articles) ? articles : [];
  const queue = list.filter((a) => a && a.audioUrl);
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

/* ---- 再生できないエピソードの自動スキップ ----
   再生エラー・play() の拒否・再生中のストールで「このエピソードは
   再生できない」と判断したら、止まったままにせずキューの次へ
   自動で進むための部品。送り先の決定はここ (純粋関数) で行い、
   検知と実行は App.vue 側が担う。 */

// 連続失敗の絶対上限。キューが長い場合でも、失敗が続いたら
// この回数で送りを止める (下の failureSkipLimit と併用)。
export const MAX_FAILURE_SKIPS = 10;

// 連続失敗の上限: 「キューの曲数を1巡する分」と絶対上限の
// 小さい方。全曲が壊れている場合でも、キューを1巡したところで
// 止まる (全体繰り返し・ランダムでも無限に回らない)。
export function failureSkipLimit(queueLength) {
  const n = Number.isFinite(queueLength) ? Math.floor(queueLength) : 0;
  if (n <= 0) return 0;
  return Math.min(n, MAX_FAILURE_SKIPS);
}

// 再生に失敗したときの送り先。進み方自体は終了時の自動送り
// (nextEpisodePlan) と同じだが、単曲リピート中でも壊れた
// エピソード自体は繰り返さない (repeat 'one' は 'none' として
// 解釈する)。consecutiveFailures は今回の失敗を含めた連続失敗数
// で、上限を超えたら { type: 'stop' } を返して送りを止める。
export function failedEpisodePlan({ queue, currentId, repeat = 'none', shuffle = false, playedIds, randomPick, consecutiveFailures = 1 } = {}) {
  const ids = Array.isArray(queue) ? queue : [];
  if (!ids.length) return { type: 'stop' };
  if (consecutiveFailures > failureSkipLimit(ids.length)) return { type: 'stop' };
  return nextEpisodePlan({
    queue: ids,
    currentId,
    repeat: repeat === 'one' ? 'none' : repeat,
    shuffle,
    playedIds,
    randomPick,
  });
}

/* ---- ストール (再生が止まったまま) の検知 ---- */

// 再生意思があるのに表示位置がこの時間 (ミリ秒) 進まなければ、
// そのエピソードは再生できないとみなす。
export const STALL_THRESHOLD_MS = 20_000;

// 表示位置の進み具合を観測する小さな状態機械。App.vue 側が
// タイマーの tick ごとに observe(表示位置, 現在時刻) を呼ぶ。
// 実時間ではなく位置の差で判定するため、バックグラウンドで
// タイマーが間引かれても、実際に再生できていれば位置が進んで
// いて誤判定しない。
export function createStallTracker({ thresholdMs = STALL_THRESHOLD_MS } = {}) {
  let lastPos = null;
  let lastAdvanceAt = 0;
  return {
    // 曲の切り替わり・シーク・再開のたびに計測をやり直す
    // (切り替わり直後とシーク直後の猶予になる)。
    reset(now) {
      lastPos = null;
      lastAdvanceAt = Number.isFinite(now) ? now : 0;
    },
    // 戻り値は { progressed, stalled }。progressed は前回の観測
    // から位置が進んだこと (正常に再生できている証拠)。
    observe(pos, now) {
      if (!Number.isFinite(pos) || !Number.isFinite(now)) return { progressed: false, stalled: false };
      if (lastPos === null) {
        lastPos = pos;
        lastAdvanceAt = now;
        return { progressed: false, stalled: false };
      }
      if (pos !== lastPos) {
        // 進んだ場合も、シーク等で後退した場合も基準を取り直す。
        const progressed = pos > lastPos;
        lastPos = pos;
        lastAdvanceAt = now;
        return { progressed, stalled: false };
      }
      return { progressed: false, stalled: now - lastAdvanceAt >= thresholdMs };
    },
  };
}

/* ---- 前へ／次へボタン (blog の musicPlayer と同じ規則) ---- */

// 両端で折り返す1ステップ移動。blog の stepIndex と同じ式。
export function stepIndex(index, count, delta) {
  if (!count) return 0;
  return (((index + delta) % count) + count) % count;
}

// 前へ (delta -1)／次へ (delta +1) の遷移先を記事IDで決める。
// blog の musicPlayer のボタン挙動に対応する:
//   ランダムでない → stepIndex で両端を折り返す (末尾の「次へ」は
//                    先頭へ、先頭の「前へ」は末尾へ)。
//   ランダムの「次へ」→ 現在以外のキュー内から randomPick で1件。
//   ランダムの「前へ」→ history (再生した順の記事ID列) を
//                    さかのぼり、現在と異なる直近の1件 (キューに
//                    残っているもの)。無ければ stepIndex で前へ。
// 戻り値は { id, historyCut }。historyCut は「前へ」で履歴を
// 使った位置で、呼び出し側は履歴をその位置まで切り詰めてから
// 遷移先を積み直す (blog が startTrack で履歴を積み直す扱いに
// 合わせる)。履歴を使わなければ null。遷移先が無ければ全体を
// null で返す。
export function skipPlan({ queue, currentId, delta, shuffle = false, history = [], randomPick } = {}) {
  const ids = Array.isArray(queue) ? queue : [];
  if (!ids.length) return null;
  const pick = typeof randomPick === 'function'
    ? randomPick
    : (candidates) => candidates[Math.floor(Math.random() * candidates.length)];
  if (delta > 0) {
    if (shuffle && ids.length > 1) {
      return { id: pick(ids.filter((id) => id !== currentId)), historyCut: null };
    }
    const index = ids.indexOf(currentId);
    if (index < 0) return null;
    return { id: ids[stepIndex(index, ids.length, 1)], historyCut: null };
  }
  if (shuffle) {
    const hist = Array.isArray(history) ? history : [];
    for (let k = hist.length - 2; k >= 0; k -= 1) {
      if (hist[k] !== currentId && ids.includes(hist[k])) {
        return { id: hist[k], historyCut: k };
      }
    }
  }
  const index = ids.indexOf(currentId);
  if (index < 0) return null;
  return { id: ids[stepIndex(index, ids.length, -1)], historyCut: null };
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

// 冒頭 (この秒数以下) の位置も「途中」ではなく頭として扱い、再開
// 位置として保存・復元しない。数秒だけ再生して止めた (動作確認で
// 少しだけ聴いた等) 位置が残ると、次にそのエピソードが始まるとき
// 冒頭が飛んだように見えるため。終端側と対称の扱いにする。
export const RESUME_START_GUARD_SEC = 5;

// 位置 pos が冒頭 (RESUME_START_GUARD_SEC 秒以下) にあるか。
// 0 や不明な値は false (0 はもともと再開位置にならない)。
export function isWithinStartGuard(pos) {
  if (!Number.isFinite(pos) || pos <= 0) return false;
  return pos <= RESUME_START_GUARD_SEC;
}

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
  if (!ctx || !Number.isFinite(ctx.trueSec) || ctx.trueSec <= 0) {
    return isWithinStartGuard(pos) ? 0 : pos;
  }
  let result = pos;
  if (durationMismatch(ctx.trueSec, ctx.elementDuration) && pos > ctx.trueSec) {
    result = pos * (ctx.trueSec / ctx.elementDuration);
  }
  if (result <= ctx.trueSec && isWithinEndGuard(result, ctx.trueSec)) return 0;
  // 割り戻した結果も含め、冒頭数秒の値は再開位置として使わない
  // (旧バージョンが保存した数秒の値もここで無力化される)。
  if (isWithinStartGuard(result)) return 0;
  return result;
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
   達した時点で終了とみなす。
   要素 duration と一致する曲では、表示位置は要素の位置そのもの
   (モデル変換を通らない) なので実測モデルは要らない。ずれて
   いる曲の表示位置はモデル変換を通るため、従来どおり、この曲
   の再生中に実測したモデルがある場合に限る (端末保存の
   learned の流用だけでは発火しない。PR #45 の防御)。 */

// 既知の長さへの到達とみなす許容誤差 (秒)。durationSec の元に
// なる itunes:duration は整数秒 (四捨五入) で運ばれるため、
// durationSec は真の長さより最大で約0.5秒長くなりうる。
// 0.3 秒程度の許容では閾値 (trueSec − 0.3) がメディアの実終端
// (駐留位置) より上になって到達判定が届かない曲が出るため、
// 0.6 秒を取る。代償として、最悪で曲の最後の約0.6秒手前で
// 判定されうるが、丸め誤差を吸収するために必要。
export const KNOWN_DURATION_END_TOLERANCE_SEC = 0.6;

export function reachedKnownDurationEnd({ displayPos, trueSec, elementDuration, hasMeasuredModel } = {}) {
  if (!Number.isFinite(trueSec) || trueSec <= 0) return false;
  if (!Number.isFinite(displayPos)) return false;
  if (displayPos < trueSec - KNOWN_DURATION_END_TOLERANCE_SEC) return false;
  if (!durationMismatch(trueSec, elementDuration)) return true;
  return hasMeasuredModel === true;
}

// 到達判定をタイマーで定期的に呼ぶ間隔 (ミリ秒、App.vue 側)。
// 終端では timeupdate 自体が止まることがあるため、再生中は
// この間隔でも到達を見に行く。到達から1秒以内に遷移できる
// よう、1秒より細かく刻む。
export const END_CHECK_INTERVAL_MS = 500;

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
