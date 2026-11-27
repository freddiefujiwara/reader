// ポッドキャストプレイヤーの純粋な補助関数 (DOM / Audio 要素の操作は
// App.vue 側)。時間表示の形は blog のプレイヤー (musicPlayer.js の
// formatTime) に揃え、1時間以上のエピソードだけ H:MM:SS にする。
import { isStagingBuild } from '../staging-banner.js';

const SPEEDS = [1, 1.25, 1.5, 2];

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
const REPEAT_CYCLE = { none: 'all', all: 'one', one: 'none' };

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

// ランダム選択の既定実装 (候補から一様に1件)。呼び出し側は
// テストで差し替えられるよう randomPick を引数に取る。
function defaultRandomPick(candidates) {
  return candidates[Math.floor(Math.random() * candidates.length)];
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
  const pick = typeof randomPick === 'function' ? randomPick : defaultRandomPick;
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
export const STALL_THRESHOLD_MS = 10_000;

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
  const pick = typeof randomPick === 'function' ? randomPick : defaultRandomPick;
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

// 保存位置と、端末DBに行う操作を決める。終了フローで消した位置を
// 次曲の読み込み時に上書きしないよう、終了済みならメモリだけを0にする。
export function planPlayPositionSave({ finished, elementPosition, displayDuration, mapping }) {
  if (finished) return { position: 0, storage: 'keep' };

  // 保存は Audio 要素の時間ではなく、表示上の秒数に揃える。
  const position = Math.floor(toDisplayPosition(elementPosition || 0, mapping));
  if (isWithinEndGuard(position, displayDuration) || isWithinStartGuard(position)) {
    return { position: 0, storage: 'clear' };
  }
  return { position, storage: position > 0 ? 'save' : 'keep' };
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

// 到達とみなす幅は上の定数に固定する。PR #105 で YouTube 曲
// だけ 2.5 秒に広げる前倒しを入れたが、曲の末尾を切り捨てる
// 形になる (単曲リピートでは 2.5 秒早く巻き戻る) ため、
// 本人の判断で取りやめた (2026-11-17)。その後しばらく、幅を
// 差し替える toleranceSec 引数として口を残していたが、呼び
// 出しは常に既定値のみで実績が無いため、定数へ一本化した。
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

/* ---- フォアグラウンド復帰時の再生回復 ----
   バックグラウンドでは JS のタイマーが止まり、ページ自体が
   suspend / freeze されることがある。その間に曲が終わると、
   'ended' が来ない曲 (iOS の fMP4) や、タイマーの tick でしか
   到達を判定できない曲では、次曲への進行が復帰まで起きない
   (実機で「バックグラウンドでは次へ進まず、アプリを開くと
   始まる」症状を確認)。また、自動送りの play() が復帰まで
   保留・拒否されることもある。そこで、フォアグラウンドへ
   戻った時点で「再生する意思があるのに止まっている」状態を
   検出したら、その場で進行・再開する。判定だけをここで行い、
   実行は App.vue 側が担う。
   入力:
     hasEpisode  … 再生中のエピソードがある
     playWanted  … アプリ側に再生の意思がある (本人が一時停止
                   した場合は false になり、勝手に再開しない)
     ended       … 要素が現在の曲の終端に達している
     endFlowDone … 終了フロー (自動送り等) が既に走った
     paused      … 要素が止まっている
     reachedEnd  … 既知の長さへの到達判定が真
   戻り値: 'advance' (次曲へ進める) | 'resume' (再生し直す) |
           'none' (何もしない)。 */
export function foregroundRecoveryAction({ hasEpisode, playWanted, ended, endFlowDone, paused, reachedEnd } = {}) {
  if (!hasEpisode || !playWanted) return 'none';
  if ((ended || reachedEnd) && !endFlowDone) return 'advance';
  // 終了フロー済みの終端は、末尾で止まった正規の状態なので触らない。
  if (ended) return 'none';
  if (paused) return 'resume';
  return 'none';
}

/* ---- 遷移直後の再生開始チェック (開始ウォッチドッグ) ----
   曲の終了遷移 (役割交代・新規読み込み) で play() を出しても、
   バックグラウンドでは再生が始まらないことがある (play() が
   NotAllowedError で拒否される、または解決しても要素が動き
   出さない)。従来は誰も再試行せず、フォアグラウンド復帰時の
   回復まで止まり続けた。そこで、遷移のたびに開始を見張り、
   始まっていなければ段階的に手当てする:
     猶予を過ぎても未開始 → 'retry' (play() を再発行)
     さらに過ぎても未開始 → 'fallback' (直前まで鳴っていた
                             側の要素へ読み直して再生)
     さらに過ぎても未開始 → 'giveup' (打ち止め。従来どおり
                             フォアグラウンド回復に委ねる)
   判定は時刻の差だけ (ストール検知と同じ考え方) で、実行は
   App.vue 側が担う。タイマーが回らないバックグラウンドでも
   play() の拒否は即座に分かるため、その場合は blocked で
   猶予を待たずに1段進める。段階は単調に進み、同じ行動を
   二度返さない。開始が確認できたら disarm する。 */

// 再発行までの猶予 (ミリ秒)。先読み済みの要素は通常この
// 時間内に 'playing' が来る。新規読み込みの場合は、データが
// 届くまでの間は呼び出し側が postpone で猶予を延ばす。
export const START_RETRY_DELAY_MS = 3_000;
// 再発行してからフォールバックまでの猶予 (ミリ秒)。
export const START_FALLBACK_DELAY_MS = 5_000;
// フォールバックしてから打ち止めまでの猶予 (ミリ秒)。
export const START_GIVEUP_DELAY_MS = 5_000;

export function createStartWatchdog({
  retryDelayMs = START_RETRY_DELAY_MS,
  fallbackDelayMs = START_FALLBACK_DELAY_MS,
  giveupDelayMs = START_GIVEUP_DELAY_MS,
} = {}) {
  // 'idle' (見張っていない) → 'armed' → 'retried' →
  // 'fallbacked' → 'done' (打ち止め済み)。
  let stage = 'idle';
  let stageAt = 0;
  function advance(now) {
    stageAt = now;
    if (stage === 'armed') { stage = 'retried'; return 'retry'; }
    if (stage === 'retried') { stage = 'fallbacked'; return 'fallback'; }
    stage = 'done';
    return 'giveup';
  }
  return {
    // 遷移で play() を出した時点で見張り始める。
    arm(now) {
      stage = 'armed';
      stageAt = Number.isFinite(now) ? now : 0;
    },
    // 開始が確認できた・本人が止めた等で見張りをやめる。
    disarm() {
      stage = 'idle';
    },
    // まだ読み込み中で開始できないのが当然の間、段階を進めず
    // 猶予の起点だけを今へずらす。
    postpone(now) {
      if (stage === 'armed' || stage === 'retried' || stage === 'fallbacked') {
        stageAt = Number.isFinite(now) ? now : stageAt;
      }
    },
    // 観測: 現在の段階の猶予を過ぎていれば次の行動を返す。
    observe(now) {
      if (!Number.isFinite(now)) return 'none';
      if (stage === 'armed' && now - stageAt >= retryDelayMs) return advance(now);
      if (stage === 'retried' && now - stageAt >= fallbackDelayMs) return advance(now);
      if (stage === 'fallbacked' && now - stageAt >= giveupDelayMs) return advance(now);
      return 'none';
    },
    // play() の拒否などで未開始が即座に分かったとき、猶予を
    // 待たずに次の行動を返す。
    blocked(now) {
      if (stage === 'idle' || stage === 'done') return 'none';
      return advance(Number.isFinite(now) ? now : stageAt);
    },
  };
}

/* ---- 回線切り替わり時の読み直しガード ----
   再生中に回線が切り替わると (自宅 Wi-Fi → モバイル回線等)、
   要素は位置だけ進んで音が出なくなることがある (実機で
   2026-11-22 朝に確認: 交代の2秒後に回線が切り替わり、その
   曲は全長を無音のまま進みきった)。要素の出力レベルはページ
   から測れないため無音そのものは検知できず、引き金である
   回線イベント ('offline' / 'online') を受けて、再生中の
   エピソードを現在位置から読み直すことで対処する。
   このガードは「読み直してよいか」の判定だけを持つ純粋な
   状態機械で、実行は App.vue 側が担う (開始ウォッチドッグと
   同じ分担)。暴走防止は2段: 回線イベントが短時間に連続して
   も印は最初の1つにまとめ、読み直した直後はクールダウンの
   間は次を受けない。印は有効期限つきで、古い印は捨てる
   (一時停止中に立った印が、再開直後に遅れて効くことを防ぐ)。 */

// 読み直し直後に次を受けない時間 (ミリ秒)。
export const ROUTE_RELOAD_COOLDOWN_MS = 60_000;
// 印の有効期限 (ミリ秒)。これを過ぎた印は捨てる。
export const ROUTE_RELOAD_PENDING_TTL_MS = 30_000;

export function createRouteReloadGuard({
  cooldownMs = ROUTE_RELOAD_COOLDOWN_MS,
  pendingTtlMs = ROUTE_RELOAD_PENDING_TTL_MS,
} = {}) {
  // 回線イベントの印が立った時刻 (null は印なし) と、直近に
  // 読み直した時刻。
  let notedAt = null;
  let lastReloadAt = null;
  return {
    // 回線イベントを受ける。印を立てるだけ (連続イベントは
    // 最初の印にまとめる)。
    note(now) {
      if (!Number.isFinite(now)) return;
      if (notedAt === null) notedAt = now;
    },
    // 印を取り出してよいか。取り出したら印を下ろし、クール
    // ダウンを始める。印が古すぎれば捨て、クールダウン中は
    // 取り出さない (印は残るが、有効期限でいずれ捨てられる)。
    take(now) {
      if (notedAt === null || !Number.isFinite(now)) return false;
      if (now - notedAt > pendingTtlMs) {
        notedAt = null;
        return false;
      }
      if (lastReloadAt !== null && now - lastReloadAt < cooldownMs) return false;
      notedAt = null;
      lastReloadAt = now;
      return true;
    },
    // 曲の切り替わり・本人の停止等で、前の文脈の印を持ち越さ
    // ない (クールダウンは保つ)。
    clear() {
      notedAt = null;
    },
  };
}

/* ---- 再生モードの端末保存 (セッションキーと同じ環境分け) ---- */

export function playModeKey(env) {
  return isStagingBuild(env) ? 'reader:player-mode:v1:staging' : 'reader:player-mode:v1';
}

const DEFAULT_PLAY_MODE = { shuffle: false, repeat: 'none' };

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
