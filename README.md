# reader

Web版RSSリーダー `/reader` のフロントエンド (Vue 3 + Vite)。

newsboat で読んでいる登録フィードをスマホでも読むための画面で、バックエンドは
[reader-gas](https://github.com/freddiefujiwara/reader-gas) (Google Apps Script)。
既読・スターはサーバー側に保持するので、端末間で同期する。

- 見た目は xuexi と共通のデザイントークン (生成り背景、朱の primary、白カード) を使う
- 認証は Google Sign-In → reader-gas が IDトークンを検証してセッションを発行する
  (許可アカウントの判定はサーバー側のみ。クライアント側では判定しない)
- 一時アクセスリンク `#share=<トークン>` は読み取り専用セッションに交換し、
  交換後すぐに URL からトークンを消す。読み取り専用では既読・スター操作を出さない

## API の接続先

`src/config.js` の `"<API>"` を、ビルド時に CI が GitHub Secret `API`
(reader-gas の /exec URL) で置換する (他のアプリと同じ方式)。
未置換のままビルドすると API_URL は空になり、画面に未設定の案内が出る。

## 開発

```sh
npm install
npm test          # vitest (単体テスト)
npm run build     # 本番ビルド (dist/, base=/reader/)
npm run build:staging  # ステージングビルド (dist-staging/, base=/reader/staging/)
npm run test:staging   # playwright で公開中のステージングを確認 (e2e/staging.check.js)
```

セッションの localStorage キーは本番 `reader:session:v1` /
ステージング `reader:session:v1:staging` で分けている。

## CI

ワークフローファイル (`.github/workflows/`) は GitHub MCP では push できないため、
このリポジトリには含めていない。`WORKFLOW-DRAFT.md` の内容をブラウザで
`.github/workflows/node.js.yml` と `.github/workflows/staging.yml` として追加すること
(xuexi の実物ワークフローが手本: PR ではステージングだけにデプロイされ単体テスト＋E2E が
ゲートになり、マージで本番に公開される)。
