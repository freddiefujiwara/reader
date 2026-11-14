import { describe, it, expect } from 'vitest';
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
  it('同じフィードの音声つき記事だけを、表示順のまま抜き出す', () => {
    const a = ep('a', 'f1');
    const b = ep('b', 'f2');
    const c = ep('c', 'f1');
    const d = { id: 'd', feedId: 'f1', audioUrl: '', title: 'd' };
    const queue = buildQueue([a, b, c, d], a);
    expect(queue.map((x) => x.id)).toEqual(['a', 'c']);
  });
  it('開始エピソードがリストに無ければ、その1件だけのキューにする', () => {
    const a = ep('a', 'f1');
    const z = ep('z', 'f1');
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
