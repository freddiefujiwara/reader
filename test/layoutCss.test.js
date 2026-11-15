import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

// 下部固定バー (.bottom-bar) とプレイヤーバー (.player-bar) の
// 重なり防止の契約を CSS のテキストで固定する。ログイン後の画面で
// しか2本のバーは同時に出ず、ステージングの e2e (未ログインの
// 読み取り専用ゲート) では幾何を測れないため、バー同士の高さの
// 取り決め (単一の CSS 変数を両方が参照すること) をここで守る。
// (jsdom 環境では import.meta.url が file スキームにならないため、
// 実行ディレクトリ基準で読む。)
const css = readFileSync(resolve(process.cwd(), 'src/style.css'), 'utf8');

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : '';
}

describe('下部バーとプレイヤーバーの重なり防止', () => {
  it('下部バーの高さが CSS 変数で定義され、バー自身の高さに使われている', () => {
    expect(css).toContain('--bottom-bar-height:');
    expect(ruleBody('.bottom-bar')).toContain('height: var(--bottom-bar-height)');
  });

  it('プレイヤーバーは下部バーの高さの分だけ持ち上がる (重ならない)', () => {
    expect(ruleBody('.player-bar')).toContain('bottom: var(--bottom-bar-height)');
  });
});

describe('ジャンル候補の配置', () => {
  it('候補 (.genre-suggestions) は通常フローの flex で、絶対配置ではない', () => {
    const body = ruleBody('.genre-suggestions');
    expect(body, '候補のルールがある').not.toBe('');
    expect(body).toContain('display: flex');
    expect(body).not.toContain('position: absolute');
    expect(body).not.toContain('position: fixed');
  });
});

describe('共有リンクのボタンの配置', () => {
  it('発行・無効化の行 (.share-actions) は折り返さず横並びにする', () => {
    const body = ruleBody('.share-actions');
    expect(body, '共有リンクのボタン行のルールがある').not.toBe('');
    expect(body).toContain('flex-wrap: nowrap');
  });

  it('ボタンは均等幅で、狭い画面でもはみ出さない', () => {
    const body = ruleBody('.share-actions > button');
    expect(body, 'ボタンの幅配分のルールがある').not.toBe('');
    expect(body).toContain('flex: 1 1 0');
    expect(body).toContain('min-width: 0');
  });
});
