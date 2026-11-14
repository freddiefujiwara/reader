import { describe, it, expect } from 'vitest';
import { parseFeedXml, decodeXmlEntities, stripTags, toIsoDate } from '../src/lib/feedParse.js';

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>サンプルニュース</title>
    <item>
      <title><![CDATA[最初の記事 & 補足]]></title>
      <link>https://example.com/articles/1</link>
      <guid isPermaLink="false">urn:example:1</guid>
      <pubDate>Fri, 14 Nov 2026 07:30:00 +0900</pubDate>
      <description>&lt;p&gt;概要の&lt;b&gt;本文&lt;/b&gt;です。&lt;/p&gt;</description>
      <dc:creator>山田太郎</dc:creator>
    </item>
    <item>
      <title>二件目</title>
      <link>https://example.com/articles/2</link>
      <pubDate>Thu, 13 Nov 2026 10:00:00 GMT</pubDate>
      <description>プレーンな概要</description>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atomブログ</title>
  <entry>
    <id>tag:example.com,2026:entry-1</id>
    <title>Atomの記事</title>
    <link rel="self" href="https://example.com/feed.atom" />
    <link rel="alternate" href="https://example.com/entries/1" />
    <published>2026-11-14T01:02:03Z</published>
    <updated>2026-11-14T02:00:00Z</updated>
    <summary type="html">&lt;p&gt;Atomの概要&lt;/p&gt;</summary>
    <author><name>佐藤花子</name></author>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://example.com/">
    <title>RDFニュース</title>
  </channel>
  <item rdf:about="https://example.com/rdf/1">
    <title>RDFの記事</title>
    <link>https://example.com/rdf/1</link>
    <dc:date>2026-11-12T09:00:00+09:00</dc:date>
    <description>RDFの概要</description>
    <dc:creator>RDF記者</dc:creator>
  </item>
</rdf:RDF>`;

describe('parseFeedXml (RSS 2.0)', () => {
  const entries = parseFeedXml(RSS2, { id: 'sample' });
  it('item をすべて取り出す', () => {
    expect(entries.length).toBe(2);
  });
  it('guid・タイトル (CDATA) ・リンク・日付・概要・著者を変換する', () => {
    const [first] = entries;
    expect(first.guid).toBe('urn:example:1');
    expect(first.title).toBe('最初の記事 & 補足');
    expect(first.link).toBe('https://example.com/articles/1');
    expect(first.publishedAt).toBe('2026-11-13T22:30:00.000Z');
    expect(first.summary).toBe('概要の 本文 です。');
    expect(first.author).toBe('山田太郎');
  });
  it('guid が無ければリンクを guid にする', () => {
    expect(entries[1].guid).toBe('https://example.com/articles/2');
    expect(entries[1].publishedAt).toBe('2026-11-13T10:00:00.000Z');
  });
});

describe('parseFeedXml (Atom)', () => {
  const entries = parseFeedXml(ATOM, { id: 'atom' });
  it('entry の id を guid、alternate リンクを採用する', () => {
    expect(entries.length).toBe(1);
    expect(entries[0].guid).toBe('tag:example.com,2026:entry-1');
    expect(entries[0].link).toBe('https://example.com/entries/1');
    expect(entries[0].publishedAt).toBe('2026-11-14T01:02:03.000Z');
    expect(entries[0].summary).toBe('Atomの概要');
    expect(entries[0].author).toBe('佐藤花子');
  });
});

describe('parseFeedXml (RSS 1.0 / RDF)', () => {
  const entries = parseFeedXml(RDF, { id: 'rdf' });
  it('rdf:about を guid、dc:date / dc:creator を変換する', () => {
    expect(entries.length).toBe(1);
    expect(entries[0].guid).toBe('https://example.com/rdf/1');
    expect(entries[0].publishedAt).toBe('2026-11-12T00:00:00.000Z');
    expect(entries[0].author).toBe('RDF記者');
  });
});

describe('補助関数', () => {
  it('decodeXmlEntities は数値参照と名前付き参照を戻す', () => {
    expect(decodeXmlEntities('a &amp; b &lt;tag&gt; &#65;&#x42;')).toBe('a & b <tag> AB');
  });
  it('stripTags はエスケープされたタグも取り除き空白を詰める', () => {
    expect(stripTags('&lt;p&gt;hello&lt;/p&gt;\n  world')).toBe('hello world');
  });
  it('toIsoDate は解釈できない値を空文字にする', () => {
    expect(toIsoDate('not-a-date')).toBe('');
    expect(toIsoDate('')).toBe('');
    expect(toIsoDate('2026-11-14')).toBe('2026-11-14T00:00:00.000Z');
  });
  it('空の入力ではエントリゼロ', () => {
    expect(parseFeedXml('', { id: 'x' })).toEqual([]);
    expect(parseFeedXml('<html><body>not a feed</body></html>', { id: 'x' })).toEqual([]);
  });
});
