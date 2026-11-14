// RSS 2.0 / RSS 1.0 (RDF) / Atom のパース (純JS、依存なし)。
// reader-gas の parseFeed とその補助関数をクライアント側へ移植したもの。
// サーバー側と同じ規則でエントリを取り出すため、記事ID (feed_id と
// guid/リンクから作る) がサーバー保存分と一致する。
// エントリ: { guid, title, link, publishedAt, summary, author }

const SUMMARY_MAX_CHARS = 500;

export function decodeXmlEntities(text) {
  if (!text) return '';
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)))
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
export function parseXml(xmlText) {
  const src = String(xmlText || '');
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const pushText = (raw, isCdata) => {
    if (!raw) return;
    stack[stack.length - 1].text += isCdata ? raw : decodeXmlEntities(raw);
  };
  while (i < src.length) {
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
  return decoded.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function summarize(html, maxChars) {
  const limit = maxChars || SUMMARY_MAX_CHARS;
  const text = stripTags(html);
  return text.length > limit ? text.slice(0, limit) : text;
}

export function toIsoDate(value) {
  if (!value) return '';
  const t = Date.parse(String(value).trim());
  if (!t && t !== 0) return '';
  if (Number.isNaN(t)) return '';
  return new Date(t).toISOString();
}

// フィード XML をエントリ配列へ変換する。feed は guid の決定には使わず、
// 呼び出し側がフィード文脈を持つための受け口 (サーバー版と形を揃える)。
export function parseFeedXml(xmlText, feed) {
  void feed;
  const root = parseXml(xmlText);
  const items = [];
  const pushItem = (guid, title, link, publishedAt, summarySource, author) => {
    const key = guid || link;
    if (!key || !link) return;
    items.push({
      guid: String(key),
      title: String(title || '').trim() || '(no title)',
      link: String(link).trim(),
      publishedAt: toIsoDate(publishedAt),
      summary: summarize(summarySource || ''),
      author: String(author || '').trim(),
    });
  };
  // RSS 2.0: rss > channel > item
  findAllNodes(root, 'channel').forEach((channel) => {
    childNodes(channel, 'item').forEach((item) => {
      pushItem(
        childText(item, 'guid') || childText(item, 'link'),
        childText(item, 'title'),
        childText(item, 'link'),
        childText(item, 'pubdate') || childText(item, 'date'),
        childText(item, 'description') || childText(item, 'encoded'),
        childText(item, 'author') || childText(item, 'creator')
      );
    });
  });
  // RSS 1.0 / RDF: ルート要素の直下にある item 要素。
  const docEl = root.children.length ? root.children[0] : null;
  if (docEl) {
    childNodes(docEl, 'item').forEach((item) => {
      pushItem(
        item.attrs.about || childText(item, 'link'),
        childText(item, 'title'),
        childText(item, 'link'),
        childText(item, 'date'),
        childText(item, 'description'),
        childText(item, 'creator')
      );
    });
  }
  // Atom: feed ルート配下の entry 要素。
  findAllNodes(root, 'entry').forEach((entry) => {
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
      authorNode ? childText(authorNode, 'name') : ''
    );
  });
  return items;
}
