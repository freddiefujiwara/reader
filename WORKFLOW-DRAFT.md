# WORKFLOW-DRAFT — .github/workflows/ 追加用ドラフト

> このファイルはドラフトであり、CI では実行されない。
> GitHub MCP は `.github/workflows/` 配下を push できないため、内容をブラウザで
> `.github/workflows/node.js.yml` と `.github/workflows/staging.yml` として追加すること。
> 手本は xuexi の実物ワークフロー。追加前に実物と突き合わせ、差があれば実物に合わせる。
>
> 注意 (過去の事故からの決まり):
> - Vite の build は出力先 (dist) を毎回空にする。そのため、ステージング版を本番 dist へ
>   同梱するステップは、必ず本番 Build ステップの「後」に置く。
> - job レベルの `if` で secrets コンテキストを参照しない (ワークフロー全体が無効になる)。
>   本番公開の条件はイベント種別 (push のみ) で判定する。
> - PR では本番公開しない (gh-pages へのデプロイは push 時のみ)。PR の確認は
>   staging.yml がステージング環境へだけデプロイし、E2E がゲートになる。

## .github/workflows/node.js.yml

```yaml
name: Node.js CI

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [24.x]
    steps:
      - uses: actions/checkout@v7
      - name: Use Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v7
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm
      - name: Install dependencies
        run: npm install
      - name: Run tests
        run: npm test
      - name: Inject API secret
        run: sed -i -e 's@<API>@${{ secrets.API }}@g' src/config.js
      - name: Build
        run: npm run build --if-present
      # ステージング同梱は本番 Build の後 (Vite は dist を毎回空にするため)。
      - name: Build staging variant into dist/staging
        run: |
          npm run build:staging
          mkdir -p dist/staging
          cp -r dist-staging/* dist/staging/
      - name: "Deploy to gh-pages"
        uses: JamesIves/github-pages-deploy-action@releases/v3
        if: ${{ matrix.node-version == '24.x' && github.event_name == 'push' }}
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          BRANCH: gh-pages
          FOLDER: dist
```

## .github/workflows/staging.yml

```yaml
name: Deploy Staging Preview

on:
  push:
    branches-ignore: ["main"]
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: staging-preview
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: Use Node.js 24.x
        uses: actions/setup-node@v7
        with:
          node-version: '24'
          cache: npm
      - name: Install dependencies
        run: npm install
      - name: Run tests
        run: npm test
      - name: Inject API secret
        run: sed -i -e 's@<API>@${{ secrets.API }}@g' src/config.js
      - name: Build staging variant
        run: npm run build:staging
      - name: Deploy staging preview to GitHub Pages
        uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./dist-staging
          destination_dir: staging
          keep_files: true

  e2e:
    needs: build
    runs-on: ubuntu-latest
    container:
      image: mcr.microsoft.com/playwright:v1.65.0-noble
    steps:
      - uses: actions/checkout@v7
      - name: Install dependencies
        run: npm ci
      - name: Wait for the preview to be published
        run: sleep 60
      - name: Check the staging preview in a real browser
        env:
          HOME: /root
        run: npx playwright test e2e/staging.check.js
      - uses: actions/upload-artifact@v7
        if: failure()
        with:
          name: playwright-traces
          path: test-results/
          if-no-files-found: ignore
```
