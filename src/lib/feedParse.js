// RSS 2.0 / RSS 1.0 (RDF) / Atom のパース (純JS、依存なし)。
// reader-gas の parseFeed とその補助関数をクライアント側へ移植したもの。
// サーバー側と同じ規則でエントリを取り出すため、記事ID (feed_id と
// guid/リンクから作る) がサーバー保存分と一致する。
// エントリ: { guid, title, link, publishedAt, summary, content, author,
//              audioUrl, durationSec }
// audioUrl / durationSec はポッドキャスト用 (enclosure と
// itunes:duration) で、音声が無いエントリでは '' / null になる。
// content はフィードが全文を持つ場合 (RSS の content:encoded、Atom の
// content) の本文テキストで、カードの展開表示専用。要約より長くない
// 場合は '' (要約と同じ本文が要約側へ寄っている場合を含む)。

// 要約の保存上限。カードの「もっと見る」展開で全文を読めるよう、
// 旧上限 (500) から 5000 へ緩めた。切り詰めはここだけで、表示側は
// CSS の line-clamp (3行) が担う。
const SUMMARY_MAX_CHARS = 5000;

// 数値文字参照を文字へ。範囲外 (U+10FFFF 超) の値は String.fromCodePoint
// が RangeError になるため、ブラウザと同じく置換文字 (U+FFFD) にする。
// 壊れた参照1つでフィード全体の取り込みが落ちないようにするため。
function codePointOrReplacement(cp) {
  return cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
}

export function decodeXmlEntities(text) {
  if (!text) return '';
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => codePointOrReplacement(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => codePointOrReplacement(parseInt(num, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function localName(tag) {
  const raw = String(tag || '').trim();
  const idx = raw.indexOf(':');
  return (idx >= 0 ? raw.slice(idx + 1) : raw).toLowerCase();
}

function parseAttrs(attrText) {
  const attrs = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(attrText)) !== null) {
    attrs[localName(m[1])] = decodeXmlEntities(m[2] !== undefined ? m[2] : m[3]);
    attrs[m[1]] = attrs[localName(m[1])];
  }
  return attrs;
}

// 最小 XML パーサ。Node: { name (ローカル名・小文字), attrs, children, text }
// 本体はジェネレータ (parseXmlGen) で、入力を一定量進めるごとに
// yield する。同期版 (parseXml) は最後まで一気に進め、非同期版
// (parseXmlChunked) は yield のたびにメインスレッドへ制御を返す。
// 大きいフィード (数MB) のパースが単一の同期処理のままだと、その間
// タップやスクロールが一切処理されず「ボタンの効きが悪い」体感に
// なるためで、出来上がる木は両版で完全に同じになる。
const PARSE_YIELD_CHARS = 256 * 1024;
const EXTRACT_YIELD_ITEMS = 50;

const yieldToMain = () => new Promise((resolve) => { setTimeout(resolve, 0); });

function drainSync(gen) {
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}

async function drainAsync(gen) {
  let step = gen.next();
  while (!step.done) {
    await yieldToMain();
    step = gen.next();
  }
  return step.value;
}

export function parseXml(xmlText) {
  return drainSync(parseXmlGen(xmlText));
}

export async function parseXmlChunked(xmlText) {
  return drainAsync(parseXmlGen(xmlText));
}

function* parseXmlGen(xmlText) {
  const src = String(xmlText || '');
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  let lastYieldAt = 0;
  const pushText = (raw, isCdata) => {
    if (!raw) return;
    stack[stack.length - 1].text += isCdata ? raw : decodeXmlEntities(raw);
  };
  while (i < src.length) {
    if (i - lastYieldAt >= PARSE_YIELD_CHARS) {
      yield;
      lastYieldAt = i;
    }
    const lt = src.indexOf('<', i);
    if (lt < 0) { pushText(src.slice(i), false); break; }
    if (lt > i) pushText(src.slice(i, lt), false);
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      pushText(end < 0 ? src.slice(lt + 9) : src.slice(lt + 9, end), true);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt + 2);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    const gt = src.indexOf('>', lt + 1);
    if (gt < 0) break;
    const inside = src.slice(lt + 1, gt);
    if (inside.startsWith('/')) {
      const name = localName(inside.slice(1));
      // 対応する開始要素まで戻る (軽い入れ子崩れは許容する)。
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].name === name) { stack.length = s; break; }
      }
      i = gt + 1;
      continue;
    }
    const selfClosing = inside.endsWith('/');
    const bodyText = selfClosing ? inside.slice(0, -1) : inside;
    const spaceIdx = bodyText.search(/[\s]/);
    const tagName = spaceIdx < 0 ? bodyText : bodyText.slice(0, spaceIdx);
    const attrText = spaceIdx < 0 ? '' : bodyText.slice(spaceIdx + 1);
    const node = { name: localName(tagName), attrs: parseAttrs(attrText), children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }
  return root;
}

function childNodes(node, name) {
  if (!node) return [];
  return node.children.filter((c) => c.name === name);
}

function firstChildNode(node, name) {
  const found = childNodes(node, name);
  return found.length ? found[0] : null;
}

function nodeText(node) {
  if (!node) return '';
  // 要素自身のテキスト＋子孫のテキスト (Atom の summary/content の入れ子対応)。
  let out = node.text || '';
  node.children.forEach((c) => { out += nodeText(c); });
  return out.trim();
}

function childText(node, name) {
  return nodeText(firstChildNode(node, name));
}

function findAllNodes(node, name, out) {
  const acc = out || [];
  if (!node) return acc;
  node.children.forEach((c) => {
    if (c.name === name) acc.push(c);
    findAllNodes(c, name, acc);
  });
  return acc;
}

export function stripTags(html) {
  // 先にデコードして、エスケープされたマークアップ (&lt;p&gt; 等) も
  // タグとして取り除く。プレーンテキストの実体参照はタグ除去を生き残る。
  const decoded = decodeXmlEntities(String(html || ''));
  // <br> と段落などの閉じタグは改行として残す。ダッシュボード系
  // フィードの改行付きプレーンテキストと HTML の段落構造を、要約の
  // 展開表示 (white-space: pre-line) で再現するため。
  const withBreaks = decoded
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|blockquote|pre|h[1-6])>/gi, '\n');
  return normalizeSummaryWhitespace(withBreaks.replace(/<[^>]*>/g, ' '));
}

// 要約テキストの空白整形。改行は保持し、行内の空白 (スペース・タブ・
// 全角スペース等) の連続は1つのスペースに詰める。改行コードは \n に
// 統一し、3つ以上連続する改行は2つに詰める。各行の前後の空白も落とす。
function normalizeSummaryWhitespace(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function summarize(html, maxChars) {
  const limit = maxChars || SUMMARY_MAX_CHARS;
  const text = stripTags(html);
  return text.length > limit ? text.slice(0, limit) : text;
}

// itunes:duration の表記ゆれ ("3723" / "34:53" / "2:34:53") を秒へ。
// 解釈できない値は null。
export function parseItunesDuration(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text));
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return null;
  return Math.round(parts.map(Number).reduce((acc, n) => acc * 60 + n, 0));
}

const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.ogg', '.opus'];

// enclosure (RSS) や rel="enclosure" の link (Atom) が音声かどうか。
// type が audio/* なら採用。type が無い場合は URL の拡張子で判断する
// (画像などの非音声 enclosure は取り違えない)。
function isAudioEnclosure(attrs) {
  const url = String((attrs && (attrs.url || attrs.href)) || '').trim();
  if (!url) return false;
  const type = String((attrs && attrs.type) || '').trim().toLowerCase();
  if (type) return type.startsWith('audio/');
  const path = url.split(/[?#]/)[0].toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => path.endsWith(ext));
}

function rssEnclosureAudioUrl(item) {
  const enc = childNodes(item, 'enclosure').find((e) => isAudioEnclosure(e.attrs));
  return enc ? String(enc.attrs.url || '').trim() : '';
}

function atomEnclosureAudioUrl(entry) {
  const link = childNodes(entry, 'link')
    .find((l) => l.attrs.rel === 'enclosure' && isAudioEnclosure(l.attrs));
  return link ? String(link.attrs.href || '').trim() : '';
}

// フィード自体のメタ情報 (チャンネルのタイトル) を取り出す。
// 記事 (item / entry) のタイトルではなく、channel / feed の直下にある
// <title> だけを見る。取れなければ title は '' (投げない)。
export function parseFeedMeta(xmlText) {
  const root = parseXml(xmlText);
  // RSS 2.0 / RSS 1.0 (RDF): channel 直下の title。
  const channels = findAllNodes(root, 'channel');
  for (const channel of channels) {
    const title = childText(channel, 'title');
    if (title) return { title };
  }
  // Atom: feed 直下の title (entry の title は見ない)。
  const feedEl = root.children.find((c) => c.name === 'feed');
  if (feedEl) {
    const title = childText(feedEl, 'title');
    if (title) return { title };
  }
  return { title: '' };
}

export function toIsoDate(value) {
  if (!value) return '';
  const t = Date.parse(String(value).trim());
  if (Number.isNaN(t)) return '';
  return new Date(t).toISOString();
}

// フィード XML をエントリ配列へ変換する。feed は guid の決定には使わず、
// 呼び出し側がフィード文脈を持つための受け口 (サーバー版と形を揃える)。
// フィード文書を最後まで受信できたか。手書きパーサは途中で切れた
// 文書でも読めた分だけ返してしまうため、削除同期のような「載って
// いない = 消えた」とみなす処理では、末尾の閉じタグまで届いたことを
// 別途確認する。RSS は </rss>、Atom は </feed> で終わる。
export function isCompleteFeedXml(xmlText) {
  const tail = String(xmlText || '').trimEnd();
  return tail.endsWith('</rss>') || tail.endsWith('</feed>');
}

export function parseFeedXml(xmlText, feed) {
  void feed;
  return drainSync(parseFeedXmlGen(xmlText));
}

// 非同期版: 処理の合間にメインスレッドへ制御を返す (parseXml の
// コメント参照)。背景更新からの呼び出しはこちらを使う。
export async function parseFeedXmlChunked(xmlText, feed) {
  void feed;
  return drainAsync(parseFeedXmlGen(xmlText));
}

function* parseFeedXmlGen(xmlText) {
  const root = yield* parseXmlGen(xmlText);
  return yield* extractItemsGen(root);
}

// エントリ抽出。本文の整形 (summarize) は件数に比例して重いため、
// 一定件数ごとに yield して、合間に操作を処理できるようにする。
function* extractItemsGen(root) {
  const items = [];
  let seen = 0;
  const pushItem = (guid, title, link, publishedAt, summarySource, author, audioUrl, durationSec, contentSource) => {
    const key = guid || link;
    if (!key || !link) return;
    const summary = summarize(summarySource || '');
    // 全文は要約より長いときだけ別に持つ。要約側が全文そのもの
    // (description が無く content へ寄せた場合) なら重ねて持たない。
    const fullText = contentSource ? summarize(contentSource) : '';
    items.push({
      guid: String(key),
      title: String(title || '').trim() || '(no title)',
      link: String(link).trim(),
      publishedAt: toIsoDate(publishedAt),
      summary,
      content: fullText.length > summary.length ? fullText : '',
      author: String(author || '').trim(),
      audioUrl: String(audioUrl || '').trim(),
      durationSec: typeof durationSec === 'number' ? durationSec : null,
    });
  };
  // RSS 2.0: rss > channel > item
  for (const channel of findAllNodes(root, 'channel')) {
    for (const item of childNodes(channel, 'item')) {
      pushItem(
        childText(item, 'guid') || childText(item, 'link'),
        childText(item, 'title'),
        childText(item, 'link'),
        childText(item, 'pubdate') || childText(item, 'date'),
        childText(item, 'description') || childText(item, 'encoded'),
        childText(item, 'author') || childText(item, 'creator'),
        rssEnclosureAudioUrl(item),
        parseItunesDuration(childText(item, 'duration')),
        childText(item, 'encoded')
      );
      seen += 1;
      if (seen % EXTRACT_YIELD_ITEMS === 0) yield;
    }
  }
  // RSS 1.0 / RDF: ルート要素の直下にある item 要素。
  const docEl = root.children.length ? root.children[0] : null;
  if (docEl) {
    for (const item of childNodes(docEl, 'item')) {
      pushItem(
        item.attrs.about || childText(item, 'link'),
        childText(item, 'title'),
        childText(item, 'link'),
        childText(item, 'date'),
        childText(item, 'description'),
        childText(item, 'creator'),
        rssEnclosureAudioUrl(item),
        parseItunesDuration(childText(item, 'duration')),
        childText(item, 'encoded')
      );
      seen += 1;
      if (seen % EXTRACT_YIELD_ITEMS === 0) yield;
    }
  }
  // Atom: feed ルート配下の entry 要素。
  for (const entry of findAllNodes(root, 'entry')) {
    const links = childNodes(entry, 'link');
    let href = '';
    links.forEach((l) => {
      if (!href && (!l.attrs.rel || l.attrs.rel === 'alternate')) href = l.attrs.href || '';
    });
    if (!href && links.length) href = links[0].attrs.href || '';
    const authorNode = firstChildNode(entry, 'author');
    pushItem(
      childText(entry, 'id') || href,
      nodeText(firstChildNode(entry, 'title')),
      href,
      childText(entry, 'published') || childText(entry, 'updated'),
      childText(entry, 'summary') || childText(entry, 'content'),
      authorNode ? childText(authorNode, 'name') : '',
      atomEnclosureAudioUrl(entry),
      parseItunesDuration(childText(entry, 'duration')),
      childText(entry, 'content')
    );
    seen += 1;
    if (seen % EXTRACT_YIELD_ITEMS === 0) yield;
  }
  return items;
}
