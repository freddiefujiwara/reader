// スクロール位置の保存・復元。対象 (window) を引数で受け取り、
// 単体テストで振る舞いを固定できるようにする。
//
// フィードの編集フォームを開くと、ジャンル選択と一覧が隠れて
// ドキュメントが極端に短くなる。その状態でフォームを閉じると、
// ブラウザのスクロールアンカリング/位置復元が働いて、再表示された
// 一覧の最下部へ飛んでしまう。開く前の位置を覚えておき、閉じて
// 一覧が戻った後に復元することで、元の位置へ戻す。
export function createScrollRestorer(win) {
  let saved = null;
  return {
    // 現在のスクロール位置を覚える。フォームを開く直前に呼ぶ。
    save() {
      saved = typeof win?.scrollY === 'number' ? win.scrollY : 0;
    },
    // 覚えた位置を破棄する (復元せずに画面を離れる場合に呼ぶ)。
    clear() {
      saved = null;
    },
    // 覚えた位置へ戻す。戻したら消費する (連続で戻さない)。
    // 覚えていなければ何もせず false を返す。
    restore() {
      if (saved === null) return false;
      const top = saved;
      saved = null;
      win.scrollTo({ top });
      return true;
    },
  };
}
