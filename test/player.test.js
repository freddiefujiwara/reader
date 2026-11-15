import { describe, it, expect } from 'vitest';
import { visibleArticles } from '../src/lib/listState.js';
import {
  formatTime,
  nextSpeed,
  clampSeek,
  progressRatio,
  buildQueue,
  nextEpisodePlan,
  nextRepeat,
  REPEAT_LABELS,
  loadPlayMode,
  savePlayMode,
  playModeKey,
  durationMismatch,
  classifyRate,
  toDisplayPosition,
  toElementPosition,
  interpretStoredPlayPos,
  isWithinEndGuard,
  RESUME_END_GUARD_SEC,
  reachedKnownDurationEnd,
  KNOWN_DURATION_END_TOLERANCE_SEC,
  END_CHECK_INTERVAL_MS,
  PRELOAD_REMAINING_SEC,
  loadTimeModel,
  saveTimeModel,
  timeModelKey,
} from '../src/lib/player.js';

describe('formatTime', () => {
  it('1時間未満は M:SS', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(65)).toBe('1:05');
    expect(formatTime(3599)).toBe('59:59');
  });
  it('1時間以上は H:MM:SS', () => {
    expect(formatTime(3600)).toBe('1:00:00');
    expect(formatTime(3723)).toBe('1:02:03');
  });
  it('解釈できない値は 0:00', () => {
    expect(formatTime(Number.NaN)).toBe('0:00');
    expect(formatTime(-30)).toBe('0:00');
    expect(formatTime(Infinity)).toBe('0:00');
    expect(formatTime(undefined)).toBe('0:00');
  });
  it('端数は切り捨てる', () => {
    expect(formatTime(65.9)).toBe('1:05');
  });
});

describe('nextSpeed', () => {
  it('1 → 1.25 → 1.5 → 2 → 1 と循環する', () => {
    expect(nextSpeed(1)).toBe(1.25);
    expect(nextSpeed(1.25)).toBe(1.5);
    expect(nextSpeed(1.5)).toBe(2);
    expect(nextSpeed(2)).toBe(1);
  });
  it('未知の値は 1 に戻す', () => {
    expect(nextSpeed(3)).toBe(1);
  });
});

describe('clampSeek', () => {
  it('[0, duration] に丸める', () => {
    expect(clampSeek(-5, 100)).toBe(0);
    expect(clampSeek(50, 100)).toBe(50);
    expect(clampSeek(150, 100)).toBe(100);
  });
  it('duration が不明なら下限だけ守る', () => {
    expect(clampSeek(50, 0)).toBe(50);
    expect(clampSeek(-5, 0)).toBe(0);
    expect(clampSeek(50, Number.NaN)).toBe(50);
  });
});

describe('progressRatio', () => {
  it('割合を 0..1 で返す', () => {
    expect(progressRatio(30, 60)).toBe(0.5);
    expect(progressRatio(0, 60)).toBe(0);
    expect(progressRatio(90, 60)).toBe(1);
  });
  it('duration がゼロ・不明なら 0', () => {
    expect(progressRatio(10, 0)).toBe(0);
    expect(progressRatio(10, Number.NaN)).toBe(0);
  });
});

const ep = (id, feedId, audioUrl = `https://example.com/${id}.mp3`) => ({ id, feedId, audioUrl, title: id });

describe('buildQueue', () => {
  it('フィードを問わず、音声つき記事だけを表示順のまま抜き出す', () => {
    const a = ep('a', 'f1');
    const b = ep('b', 'f2');
    const c = ep('c', 'f1');
    const d = { id: 'd', feedId: 'f2', audioUrl: '', title: 'd' };
    const queue = buildQueue([a, b, c, d], a);
    expect(queue.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
  it('音声の無い記事は、表示リストに含まれていても入らない', () => {
    const a = ep('a', 'f1');
    const noAudio = { id: 'n', feedId: 'f1', audioUrl: '', title: 'n' };
    const queue = buildQueue([noAudio, a], a);
    expect(queue.map((x) => x.id)).toEqual(['a']);
  });
  it('既読・未読は問わない (既読の絞り込みは表示リスト側の担当)', () => {
    const read = { ...ep('r', 'f1'), isRead: true };
    const unread = { ...ep('u', 'f2'), isRead: false };
    const queue = buildQueue([read, unread], read);
    expect(queue.map((x) => x.id)).toEqual(['r', 'u']);
  });
  it('例1: ジャンル「音楽」＋未読フィルタでは、配下の全チャンネルの未読・音声ありが入る', () => {
    const feeds = [
      { id: 'f1', category: '音楽' },
      { id: 'f2', category: '音楽' },
      { id: 'f3', category: 'ニュース' },
    ];
    const articles = [
      { ...ep('a', 'f1'), isRead: false },
      { ...ep('b', 'f2'), isRead: false },
      { ...ep('c', 'f1'), isRead: true },
      { id: 'd', feedId: 'f2', audioUrl: '', title: 'd', isRead: false },
      { ...ep('e', 'f3'), isRead: false },
    ];
    const state = { articles, feeds, feedId: '', category: '音楽', filter: 'unread' };
    const queue = buildQueue(visibleArticles(state), articles[0]);
    expect(queue.map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('例2: 単一チャンネル＋「すべて」では、そのチャンネルの既読も含めて入る', () => {
    const feeds = [
      { id: 'f1', category: '音楽' },
      { id: 'f2', category: '音楽' },
    ];
    const articles = [
      { ...ep('a', 'f1'), isRead: true },
      { ...ep('b', 'f1'), isRead: false },
      { ...ep('c', 'f2'), isRead: false },
    ];
    const state = { articles, feeds, feedId: 'f1', category: '', filter: 'all' };
    const queue = buildQueue(visibleArticles(state), articles[0]);
    expect(queue.map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('開始エピソードがリストに無ければ、その1件だけのキューにする', () => {
    const a = ep('a', 'f1');
    const z = ep('z', 'f2');
    expect(buildQueue([a], z)).toEqual([z]);
  });
  it('開始エピソードが無ければ空', () => {
    expect(buildQueue([ep('a', 'f1')], null)).toEqual([]);
    expect(buildQueue(null, null)).toEqual([]);
  });
});

describe('nextRepeat / REPEAT_LABELS', () => {
  it('なし → 全曲 → 1曲 → なし と循環し、表示名が blog と同じ', () => {
    expect(nextRepeat('none')).toBe('all');
    expect(nextRepeat('all')).toBe('one');
    expect(nextRepeat('one')).toBe('none');
    expect(nextRepeat('bogus')).toBe('none');
    expect(REPEAT_LABELS).toEqual({ none: 'リピート：なし', all: 'リピート：全曲', one: 'リピート：1曲' });
  });
});

describe('nextEpisodePlan (連続再生)', () => {
  const queue = ['a', 'b', 'c'];
  it('次のエピソードへ進む', () => {
    expect(nextEpisodePlan({ queue, currentId: 'a' })).toEqual({ type: 'advance', id: 'b' });
    expect(nextEpisodePlan({ queue, currentId: 'b' })).toEqual({ type: 'advance', id: 'c' });
  });
  it('末尾で止まる', () => {
    expect(nextEpisodePlan({ queue, currentId: 'c' })).toEqual({ type: 'stop' });
  });
  it('全体繰り返しでは末尾から先頭へ戻る', () => {
    expect(nextEpisodePlan({ queue, currentId: 'c', repeat: 'all' })).toEqual({ type: 'advance', id: 'a' });
    expect(nextEpisodePlan({ queue: ['a'], currentId: 'a', repeat: 'all' })).toEqual({ type: 'advance', id: 'a' });
  });
  it('キューが空・現在位置不明なら止まる', () => {
    expect(nextEpisodePlan({ queue: [], currentId: 'a' })).toEqual({ type: 'stop' });
    expect(nextEpisodePlan({ queue, currentId: 'z' })).toEqual({ type: 'stop' });
  });
});

describe('nextEpisodePlan (単曲繰り返し)', () => {
  it('どのモードでも同じエピソードを再生し直す', () => {
    expect(nextEpisodePlan({ queue: ['a', 'b'], currentId: 'a', repeat: 'one' })).toEqual({ type: 'replay' });
    expect(nextEpisodePlan({ queue: ['a', 'b'], currentId: 'a', repeat: 'one', shuffle: true, playedIds: new Set(['a']) })).toEqual({ type: 'replay' });
  });
});

describe('nextEpisodePlan (ランダム再生)', () => {
  const queue = ['a', 'b', 'c'];
  const lastPick = (candidates) => candidates[candidates.length - 1];
  it('未再生のものだけから、注入した randomPick で選ぶ', () => {
    let seen = null;
    const plan = nextEpisodePlan({
      queue,
      currentId: 'a',
      shuffle: true,
      playedIds: new Set(['a']),
      randomPick: (candidates) => { seen = candidates; return lastPick(candidates); },
    });
    expect(seen).toEqual(['b', 'c']);
    expect(plan).toEqual({ type: 'advance', id: 'c' });
  });
  it('再生済みは候補から外れる', () => {
    const plan = nextEpisodePlan({
      queue, currentId: 'b', shuffle: true, playedIds: new Set(['a', 'b']), randomPick: lastPick,
    });
    expect(plan).toEqual({ type: 'advance', id: 'c' });
  });
  it('ラウンドを使い切ったら止まる', () => {
    const plan = nextEpisodePlan({
      queue, currentId: 'c', shuffle: true, playedIds: new Set(['a', 'b', 'c']), randomPick: lastPick,
    });
    expect(plan).toEqual({ type: 'stop' });
  });
  it('全体繰り返しなら新しいラウンドを始める (現在分は引き直さない)', () => {
    let seen = null;
    const plan = nextEpisodePlan({
      queue,
      currentId: 'c',
      repeat: 'all',
      shuffle: true,
      playedIds: new Set(['a', 'b', 'c']),
      randomPick: (candidates) => { seen = candidates; return candidates[0]; },
    });
    expect(seen).toEqual(['a', 'b']);
    expect(plan).toEqual({ type: 'advance', id: 'a', resetPlayed: true });
  });
  it('全体繰り返し + 1件だけのキューでは、その1件を引き直す', () => {
    const plan = nextEpisodePlan({
      queue: ['a'], currentId: 'a', repeat: 'all', shuffle: true, playedIds: new Set(['a']), randomPick: lastPick,
    });
    expect(plan).toEqual({ type: 'advance', id: 'a', resetPlayed: true });
  });
});

describe('durationMismatch', () => {
  it('20% 超のずれだけを不一致とする', () => {
    expect(durationMismatch(104, 208)).toBe(true);
    expect(durationMismatch(100, 121)).toBe(true);
    expect(durationMismatch(100, 119)).toBe(false);
    expect(durationMismatch(100, 100)).toBe(false);
  });
  it('どちらか不明なら不一致にしない', () => {
    expect(durationMismatch(0, 208)).toBe(false);
    expect(durationMismatch(null, 208)).toBe(false);
    expect(durationMismatch(104, Number.NaN)).toBe(false);
    expect(durationMismatch(104, 0)).toBe(false);
    expect(durationMismatch(104, Infinity)).toBe(false);
  });
});

describe('classifyRate', () => {
  it('1.5 超は scaled、0.5〜1.5 は direct', () => {
    expect(classifyRate(2)).toBe('scaled');
    expect(classifyRate(1.51)).toBe('scaled');
    expect(classifyRate(1.5)).toBe('direct');
    expect(classifyRate(1)).toBe('direct');
    expect(classifyRate(0.5)).toBe('direct');
  });
  it('ほぼ止まっている・解釈不能なら null', () => {
    expect(classifyRate(0.2)).toBeNull();
    expect(classifyRate(0)).toBeNull();
    expect(classifyRate(Number.NaN)).toBeNull();
  });
});

describe('時間マッピング (モデルA: direct)', () => {
  const ctx = { trueSec: 104, elementDuration: 208, model: 'direct' };
  it('表示位置はそのまま、正しい長さで頭打ち', () => {
    expect(toDisplayPosition(0, ctx)).toBe(0);
    expect(toDisplayPosition(52, ctx)).toBe(52);
    expect(toDisplayPosition(150, ctx)).toBe(104);
  });
  it('シークはそのまま要素へ渡る', () => {
    expect(toElementPosition(52, ctx)).toBe(52);
    expect(toElementPosition(150, ctx)).toBe(104);
  });
});

describe('時間マッピング (モデルB: scaled)', () => {
  const ctx = { trueSec: 104, elementDuration: 208, model: 'scaled' };
  it('表示位置は比率で圧縮される', () => {
    expect(toDisplayPosition(0, ctx)).toBe(0);
    expect(toDisplayPosition(104, ctx)).toBe(52);
    expect(toDisplayPosition(208, ctx)).toBe(104);
    expect(toDisplayPosition(300, ctx)).toBe(104);
  });
  it('シークは比率で伸ばして要素へ渡り、往復が一致する', () => {
    expect(toElementPosition(52, ctx)).toBe(104);
    expect(toElementPosition(104, ctx)).toBe(208);
    expect(toElementPosition(200, ctx)).toBe(208);
    for (const t of [0, 10, 52.5, 104]) {
      expect(toDisplayPosition(toElementPosition(t, ctx), ctx)).toBeCloseTo(Math.min(t, 104));
    }
  });
});

describe('時間マッピング (補正なし)', () => {
  it('モデル未確定・長さ一致なら恒等', () => {
    const unknown = { trueSec: 104, elementDuration: 208, model: null };
    expect(toDisplayPosition(150, unknown)).toBe(150);
    expect(toElementPosition(150, unknown)).toBe(150);
    const matched = { trueSec: 104, elementDuration: 104, model: 'scaled' };
    expect(toDisplayPosition(50, matched)).toBe(50);
    expect(toElementPosition(50, matched)).toBe(50);
    expect(toDisplayPosition(50, null)).toBe(50);
  });
});

describe('isWithinEndGuard', () => {
  it('残り5秒以内を終端間際とする', () => {
    expect(RESUME_END_GUARD_SEC).toBe(5);
    expect(isWithinEndGuard(104, 104)).toBe(true);
    expect(isWithinEndGuard(99, 104)).toBe(true);
    expect(isWithinEndGuard(98, 104)).toBe(false);
    expect(isWithinEndGuard(50, 104)).toBe(false);
  });
  it('長さ不明・位置なしでは終端間際にしない', () => {
    expect(isWithinEndGuard(10, 0)).toBe(false);
    expect(isWithinEndGuard(10, null)).toBe(false);
    expect(isWithinEndGuard(0, 104)).toBe(false);
  });
});

describe('次の曲の先読み', () => {
  it('先読みを始める残り時間は60秒', () => {
    expect(PRELOAD_REMAINING_SEC).toBe(60);
  });
});

describe('interpretStoredPlayPos', () => {
  const ctx = { trueSec: 104, elementDuration: 208, model: 'scaled' };
  it('正しい長さ以下の中盤の保存値はそのまま', () => {
    expect(interpretStoredPlayPos(0, ctx)).toBe(0);
    expect(interpretStoredPlayPos(60, ctx)).toBe(60);
    expect(interpretStoredPlayPos(98, ctx)).toBe(98);
  });
  it('終端間際 (残り5秒以内) の保存値は 0 に倒す', () => {
    expect(interpretStoredPlayPos(99, ctx)).toBe(0);
    expect(interpretStoredPlayPos(104, ctx)).toBe(0);
  });
  it('正しい長さを超える旧保存値は要素スケールとみなして割り戻す', () => {
    expect(interpretStoredPlayPos(160, ctx)).toBe(80);
  });
  it('割り戻した結果が終端間際なら 0 に倒す', () => {
    expect(interpretStoredPlayPos(200, ctx)).toBe(0);
    expect(interpretStoredPlayPos(208, ctx)).toBe(0);
  });
  it('長さが一致していても終端間際の保存値は 0 に倒す', () => {
    expect(interpretStoredPlayPos(102, { trueSec: 104, elementDuration: 104, model: 'direct' })).toBe(0);
    expect(interpretStoredPlayPos(60, { trueSec: 104, elementDuration: 104, model: 'direct' })).toBe(60);
  });
  it('補正が効かない場合はそのまま', () => {
    expect(interpretStoredPlayPos(160, { trueSec: 104, elementDuration: 104, model: 'scaled' })).toBe(160);
    expect(interpretStoredPlayPos(160, null)).toBe(160);
    expect(interpretStoredPlayPos(-5, ctx)).toBe(0);
  });
});

describe('reachedKnownDurationEnd', () => {
  it('到達判定をタイマーで呼ぶ間隔は 500ms', () => {
    expect(END_CHECK_INTERVAL_MS).toBe(500);
  });
  it('要素 duration と一致する曲では、実測モデルなしで到達を終了とする', () => {
    expect(reachedKnownDurationEnd({
      displayPos: 100, trueSec: 100, elementDuration: 100, hasMeasuredModel: false,
    })).toBe(true);
    // 許容誤差 (この判定専用の0.6秒。itunes:duration の整数秒への
    // 丸めを吸収する) の境界。
    expect(reachedKnownDurationEnd({
      displayPos: 100 - KNOWN_DURATION_END_TOLERANCE_SEC, trueSec: 100, elementDuration: 100, hasMeasuredModel: false,
    })).toBe(true);
    expect(reachedKnownDurationEnd({
      displayPos: 100 - KNOWN_DURATION_END_TOLERANCE_SEC - 0.1, trueSec: 100, elementDuration: 100, hasMeasuredModel: false,
    })).toBe(false);
  });
  it('durationSec が整数秒への丸めで真の長さより長くても、駐留位置で到達とする', () => {
    // 真の長さ 100 秒のメディアが、itunes:duration の四捨五入で
    // durationSec = 100.49 になったケース。要素は真の終端 (100)
    // で駐留する。従来の 0.3 秒では閾値 (100.19) が駐留位置より
    // 上になり到達判定が届かなかった。
    expect(reachedKnownDurationEnd({
      displayPos: 100, trueSec: 100.49, elementDuration: 100, hasMeasuredModel: false,
    })).toBe(true);
    // 丸めの最大幅 (約0.5秒) を超えて手前の位置では到達としない。
    expect(reachedKnownDurationEnd({
      displayPos: 99.8, trueSec: 100.49, elementDuration: 100, hasMeasuredModel: false,
    })).toBe(false);
  });
  it('既知の長さの手前では終了としない', () => {
    expect(reachedKnownDurationEnd({
      displayPos: 95, trueSec: 100, elementDuration: 100, hasMeasuredModel: false,
    })).toBe(false);
  });
  it('durationSec が不明な曲では、この判定では終了としない', () => {
    expect(reachedKnownDurationEnd({
      displayPos: 100, trueSec: 0, elementDuration: 100, hasMeasuredModel: false,
    })).toBe(false);
    expect(reachedKnownDurationEnd({
      displayPos: 100, trueSec: null, elementDuration: 100, hasMeasuredModel: false,
    })).toBe(false);
  });
  it('要素 duration とずれている曲では、実測モデルがある場合に限る', () => {
    // ずれている曲の表示位置はモデル変換を通るため、端末保存の
    // learned の流用だけ (hasMeasuredModel: false) では発火しない。
    expect(reachedKnownDurationEnd({
      displayPos: 103.8, trueSec: 104, elementDuration: 208, hasMeasuredModel: false,
    })).toBe(false);
    expect(reachedKnownDurationEnd({
      displayPos: 103.8, trueSec: 104, elementDuration: 208, hasMeasuredModel: true,
    })).toBe(true);
  });
});

describe('時間モデルの保存', () => {
  const fakeStorage = () => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => { map.set(k, String(v)); },
      map,
    };
  };
  it('保存して読み直すと往復する', () => {
    const storage = fakeStorage();
    expect(loadTimeModel(storage, {})).toBeNull();
    saveTimeModel('scaled', storage, {});
    expect(loadTimeModel(storage, {})).toBe('scaled');
    saveTimeModel('direct', storage, {});
    expect(loadTimeModel(storage, {})).toBe('direct');
  });
  it('不正なモデルは保存せず、壊れた値は null に倒す', () => {
    const storage = fakeStorage();
    saveTimeModel('bogus', storage, {});
    expect(loadTimeModel(storage, {})).toBeNull();
    storage.map.set(timeModelKey({}), 'weird');
    expect(loadTimeModel(storage, {})).toBeNull();
  });
  it('本番とステージングでキーを分ける', () => {
    expect(timeModelKey({})).toBe('reader:player-timemodel:v1');
    expect(timeModelKey({ VITE_STAGING: '1' })).toBe('reader:player-timemodel:v1:staging');
  });
});

describe('再生モードの保存', () => {
  const fakeStorage = () => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => { map.set(k, String(v)); },
      map,
    };
  };
  it('保存して読み直すと往復する', () => {
    const storage = fakeStorage();
    savePlayMode({ shuffle: true, repeat: 'one' }, storage, {});
    expect(loadPlayMode(storage, {})).toEqual({ shuffle: true, repeat: 'one' });
    savePlayMode({ shuffle: false, repeat: 'all' }, storage, {});
    expect(loadPlayMode(storage, {})).toEqual({ shuffle: false, repeat: 'all' });
  });
  it('未保存・壊れた値・不正な値は既定 (連続再生) に倒す', () => {
    const storage = fakeStorage();
    expect(loadPlayMode(storage, {})).toEqual({ shuffle: false, repeat: 'none' });
    storage.map.set(playModeKey({}), '{not json');
    expect(loadPlayMode(storage, {})).toEqual({ shuffle: false, repeat: 'none' });
    storage.map.set(playModeKey({}), JSON.stringify({ shuffle: 'yes', repeat: 'forever' }));
    expect(loadPlayMode(storage, {})).toEqual({ shuffle: false, repeat: 'none' });
  });
  it('本番とステージングでキーを分ける', () => {
    expect(playModeKey({})).toBe('reader:player-mode:v1');
    expect(playModeKey({ VITE_STAGING: '1' })).toBe('reader:player-mode:v1:staging');
  });
});
