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

describe('要約の展開表示', () => {
  it('通常の要約 (.article-summary) は3行で省略される', () => {
    const body = ruleBody('.article-summary');
    expect(body, '要約のルールがある').not.toBe('');
    expect(body).toContain('-webkit-line-clamp: 3');
    expect(body).toContain('overflow: hidden');
  });

  it('展開した要約 (.article-summary.expanded) は行数制限が外れる', () => {
    const body = ruleBody('.article-summary.expanded');
    expect(body, '展開時のルールがある').not.toBe('');
    expect(body).toContain('-webkit-line-clamp: unset');
    expect(body).toContain('overflow: visible');
  });

  it('展開した要約では取り込みで残した改行が効く (white-space: pre-line)', () => {
    expect(ruleBody('.article-summary.expanded')).toContain('white-space: pre-line');
  });

  it('閉じた要約では改行は効かない (pre-line を付けず、空白として流れる)', () => {
    expect(ruleBody('.article-summary')).not.toContain('white-space: pre-line');
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

// min-width: 721px のメディアクエリ群の中身をまとめて取り出す
// (ルールは入れ子だが、ブロックの閉じ括弧は行頭に出る前提)。
function desktopCss() {
  return [...css.matchAll(/@media \(min-width: 721px\) \{([\s\S]*?)\n\}/g)]
    .map((m) => m[1])
    .join('\n');
}

describe('フィードチップ行の折りたたみ (PC幅)', () => {
  it('折りたたみ (.feed-chips.is-collapsed) は2行分の高さで抑え、はみ出しを隠す', () => {
    const body = ruleBody('.filter-bar .feed-chips.is-collapsed');
    expect(body, '折りたたみのルールがある').not.toBe('');
    expect(body).toContain('max-height: 94px');
    expect(body).toContain('overflow: hidden');
  });

  it('折りたたみのルールは PC幅のメディアクエリの中だけにある (スマホ幅は抑えない)', () => {
    expect(desktopCss()).toContain('.feed-chips.is-collapsed');
    const beforeDesktop = css.slice(0, css.indexOf('@media (min-width: 721px)'));
    expect(beforeDesktop).not.toContain('is-collapsed');
  });

  it('開閉トグル (.chips-toggle) は既定で出さず、PC幅でのみブロック表示する', () => {
    const body = ruleBody('.chips-toggle');
    expect(body, 'トグルのルールがある').not.toBe('');
    expect(body).toContain('display: none');
    const desktop = desktopCss();
    const m = desktop.match(/\.chips-toggle\s*\{([^}]*)\}/);
    expect(m, 'PC幅でトグルを出すルールがある').toBeTruthy();
    expect(m[1]).toContain('display: block');
  });
});

describe('スターボタンの固定', () => {
  it('スター (.star-btn) は固定幅で、☆/⭐ の切替で幅が変わらない', () => {
    const body = ruleBody('.star-btn');
    expect(body, 'スターのルールがある').not.toBe('');
    expect(body).toContain('width: 32px');
    expect(body).toContain('flex: none');
  });

  it('アクション行 (.article-foot) は横並びの flex で、スターが左端に来る前提を保つ', () => {
    const body = ruleBody('.article-foot');
    expect(body, 'アクション行のルールがある').not.toBe('');
    expect(body).toContain('display: flex');
  });
});
