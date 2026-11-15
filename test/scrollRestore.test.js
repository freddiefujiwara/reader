// スクロール位置の保存・復元 (scrollRestore.js) の単体テスト。
// フォームを開く前の位置を覚え、閉じた後に戻すための小さな部品。
// ブラウザ側の不具合 (編集中にドキュメントが短くなり、閉じると
// 一覧の最下部へ飛ぶ) への対処がこの部品の役割。
import { describe, it, expect } from 'vitest';
import { createScrollRestorer } from '../src/lib/scrollRestore.js';

function fakeWin(scrollY = 0) {
  const calls = [];
  return {
    scrollY,
    calls,
    scrollTo(opts) {
      calls.push(opts);
    },
  };
}

describe('createScrollRestorer', () => {
  it('save した位置へ restore で戻り、戻したら消費する', () => {
    const win = fakeWin(480);
    const r = createScrollRestorer(win);
    r.save();
    win.scrollY = 0; // フォームが開いて位置が変わった状態
    expect(r.restore()).toBe(true);
    expect(win.calls).toEqual([{ top: 480 }]);
    // 消費済みなので、もう一度呼んでも何もしない。
    expect(r.restore()).toBe(false);
    expect(win.calls).toEqual([{ top: 480 }]);
  });

  it('save していない restore は何もしない', () => {
    const win = fakeWin(120);
    const r = createScrollRestorer(win);
    expect(r.restore()).toBe(false);
    expect(win.calls).toEqual([]);
  });

  it('save は最新の位置で上書きする', () => {
    const win = fakeWin(100);
    const r = createScrollRestorer(win);
    r.save();
    win.scrollY = 250;
    r.save();
    expect(r.restore()).toBe(true);
    expect(win.calls).toEqual([{ top: 250 }]);
  });

  it('clear すると restore は何もしない', () => {
    const win = fakeWin(300);
    const r = createScrollRestorer(win);
    r.save();
    r.clear();
    expect(r.restore()).toBe(false);
    expect(win.calls).toEqual([]);
  });

  it('scrollY が数値でない対象では 0 を覚える', () => {
    const win = fakeWin(undefined);
    const r = createScrollRestorer(win);
    r.save();
    expect(r.restore()).toBe(true);
    expect(win.calls).toEqual([{ top: 0 }]);
  });
});
