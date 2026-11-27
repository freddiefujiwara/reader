import { describe, it, expect } from 'vitest';
import { parseFeedXml, parseFeedXmlChunked, parseXml, parseXmlChunked, parseFeedMeta, parseItunesDuration, decodeXmlEntities, stripTags, toIsoDate, summarize, isCompleteFeedXml } from '../src/lib/feedParse.js';

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

// ダッシュボード系フィード (健康ウィークリー等) は description に
// 改行付きプレーンテキストを CDATA で送る。要約にも改行が残ること。
const RSS_DASHBOARD = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>ダッシュボード</title>
    <item>
      <title>今日のダッシュボード</title>
      <link>https://example.com/dashboard/1</link>
      <guid>urn:example:dash-1</guid>
      <pubDate>Mon, 17 Nov 2026 06:20:00 GMT</pubDate>
      <description><![CDATA[【結論】
資産は増えました。

【内訳】
現金 100万円]]></description>
    </item>
  </channel>
</rss>`;

describe('parseFeedXml (改行付きプレーンテキスト)', () => {
  it('CDATA の改行は要約に残る', () => {
    const entries = parseFeedXml(RSS_DASHBOARD, { id: 'dash' });
    expect(entries.length).toBe(1);
    expect(entries[0].summary).toBe('【結論】\n資産は増えました。\n\n【内訳】\n現金 100万円');
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

describe('parseFeedXml (変形・壊れた入力への耐性)', () => {
  it('閉じられていない item からもエントリを取り出す', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item><title>閉じ忘れ</title><link>https://example.com/unclosed</link><pubDate>Fri, 14 Nov 2026 00:00:00 GMT</pubDate>
</channel></rss>`;
    const entries = parseFeedXml(xml, { id: 'x' });
    expect(entries.length).toBe(1);
    expect(entries[0].title).toBe('閉じ忘れ');
    expect(entries[0].link).toBe('https://example.com/unclosed');
  });
  it('入れ子の崩れた要素でもテキストを取り出す', () => {
    const xml = `<rss version="2.0"><channel><item>
      <title>壊れた<b>入れ子</title>
      <link>https://example.com/broken</link>
    </item></channel></rss>`;
    const entries = parseFeedXml(xml, { id: 'x' });
    expect(entries.length).toBe(1);
    expect(entries[0].title).toBe('壊れた入れ子');
  });
  it('コメント・処理命令・DOCTYPE が混ざっても実 item だけを取り出す', () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE rss>
<rss version="2.0"><channel>
  <!-- <item><title>偽物</title><link>https://example.com/fake</link></item> -->
  <?xml-stylesheet type="text/xsl" href="style.xsl"?>
  <item><title>本物</title><link>https://example.com/real</link></item>
</channel></rss>`;
    const entries = parseFeedXml(xml, { id: 'x' });
    expect(entries.map((e) => e.title)).toEqual(['本物']);
  });
  it('pubDate が無く dc:date だけの item はその日付を使う', () => {
    const xml = `<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item>
      <title>dc日付</title><link>https://example.com/dc</link>
      <dc:date>2026-11-10T05:00:00+09:00</dc:date>
    </item></channel></rss>`;
    const [entry] = parseFeedXml(xml, { id: 'x' });
    expect(entry.publishedAt).toBe('2026-11-09T20:00:00.000Z');
  });
  it('RSS の素の author 要素を著者にする', () => {
    const xml = `<rss version="2.0"><channel><item>
      <title>著者つき</title><link>https://example.com/a</link>
      <author>tanaka@example.com (田中)</author>
    </item></channel></rss>`;
    const [entry] = parseFeedXml(xml, { id: 'x' });
    expect(entry.author).toBe('tanaka@example.com (田中)');
  });
  it('description が無く content:encoded だけの item はそちらを概要にする', () => {
    const xml = `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item>
      <title>本文のみ</title><link>https://example.com/enc</link>
      <content:encoded>&lt;p&gt;エンコードされた本文&lt;/p&gt;</content:encoded>
    </item></channel></rss>`;
    const [entry] = parseFeedXml(xml, { id: 'x' });
    expect(entry.summary).toBe('エンコードされた本文');
  });
  it('guid があってもリンクの無い item は捨てる', () => {
    const xml = `<rss version="2.0"><channel>
      <item><title>リンク無し</title><guid>urn:example:nolink</guid></item>
      <item><title>リンク有り</title><link>https://example.com/ok</link></item>
    </channel></rss>`;
    const entries = parseFeedXml(xml, { id: 'x' });
    expect(entries.map((e) => e.title)).toEqual(['リンク有り']);
  });
  it('タイトルが無い item は (no title) になる', () => {
    const xml = `<rss version="2.0"><channel><item><link>https://example.com/notitle</link></item></channel></rss>`;
    const [entry] = parseFeedXml(xml, { id: 'x' });
    expect(entry.title).toBe('(no title)');
  });
});

describe('parseFeedXml (全文: content:encoded / content)', () => {
  it('RSS: description が要約、content:encoded が全文になる (タグを除き段落は改行で残る)', () => {
    const xml = `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item>
      <title>全文つき</title><link>https://example.com/full</link>
      <description>短い抜粋です。</description>
      <content:encoded><![CDATA[<p>本文の1段落目です。</p><p>本文の2段落目です。抜粋より長い続きがここにあります。</p>]]></content:encoded>
    </item></channel></rss>`;
    const [entry] = parseFeedXml(xml, { id: 'x' });
    expect(entry.summary).toBe('短い抜粋です。');
    expect(entry.content).toBe('本文の1段落目です。\n本文の2段落目です。抜粋より長い続きがここにあります。');
  });
  it('RSS: content:encoded だけの item は要約へ寄せ、全文は重ねて持たない', () => {
    const xml = `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item>
      <title>本文のみ</title><link>https://example.com/enc-only</link>
      <content:encoded>&lt;p&gt;エンコードされた本文&lt;/p&gt;</content:encoded>
    </item></channel></rss>`;
    const [entry] = parseFeedXml(xml, { id: 'x' });
    expect(entry.summary).toBe('エンコードされた本文');
    expect(entry.content).toBe('');
  });
  it('RSS: 全文が要約より短ければ全文は持たない', () => {
    const xml = `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item>
      <title>要約が長い</title><link>https://example.com/longer-summary</link>
      <description>${'あ'.repeat(300)}</description>
      <content:encoded>短い本文</content:encoded>
    </item></channel></rss>`;
    const [entry] = parseFeedXml(xml, { id: 'x' });
    expect(entry.summary).toBe('あ'.repeat(300));
    expect(entry.content).toBe('');
  });
  it('RSS: 全文も要約と同じ5000文字で切り詰める', () => {
    const xml = `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item>
      <title>長い全文</title><link>https://example.com/very-long</link>
      <description>抜粋</description>
      <content:encoded>${'い'.repeat(6000)}</content:encoded>
    </item></channel></rss>`;
    const [entry] = parseFeedXml(xml, { id: 'x' });
    expect(entry.content).toBe('い'.repeat(5000));
  });
  it('RSS: 全文の無い item は content が空文字になる', () => {
    const [entry] = parseFeedXml(RSS2, { id: 'sample' });
    expect(entry.content).toBe('');
  });
  it('Atom: summary が要約、content が全文になる', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:example.com,2026:full</id>
    <title>Atom全文つき</title>
    <link rel="alternate" href="https://example.com/atom-full" />
    <published>2026-11-14T00:00:00Z</published>
    <summary>Atomの短い概要</summary>
    <content type="html">&lt;p&gt;Atomの本文です。概要より長い本文がここに入ります。&lt;/p&gt;</content>
  </entry>
</feed>`;
    const [entry] = parseFeedXml(xml, { id: 'atom-full' });
    expect(entry.summary).toBe('Atomの短い概要');
    expect(entry.content).toBe('Atomの本文です。概要より長い本文がここに入ります。');
  });
  it('Atom: content だけの entry は要約へ寄せ、全文は重ねて持たない', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:example.com,2026:content-only</id>
    <title>Atom本文のみ</title>
    <link rel="alternate" href="https://example.com/atom-content-only" />
    <published>2026-11-14T00:00:00Z</published>
    <content type="html">&lt;p&gt;内容だけの本文&lt;/p&gt;</content>
  </entry>
</feed>`;
    const [entry] = parseFeedXml(xml, { id: 'atom-co' });
    expect(entry.summary).toBe('内容だけの本文');
    expect(entry.content).toBe('');
  });
});

describe('parseFeedXml (Atom のフォールバック)', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:example.com,2026:norel</id>
    <title>rel無しリンク</title>
    <link href="https://example.com/norel" />
    <published>2026-11-14T00:00:00Z</published>
  </entry>
  <entry>
    <id>tag:example.com,2026:selfonly</id>
    <title>selfだけ</title>
    <link rel="self" href="https://example.com/feed.atom" />
    <updated>2026-11-13T00:00:00Z</updated>
    <content type="html">&lt;p&gt;内容だけ&lt;/p&gt;</content>
  </entry>
  <entry>
    <id>tag:example.com,2026:single</id>
    <title>シングルクォート</title>
    <link rel='alternate' href='https://example.com/single' />
    <published>2026-11-12T00:00:00Z</published>
  </entry>
</feed>`;
  const entries = parseFeedXml(xml, { id: 'atom2' });
  it('rel の無い link (自己終了タグ) を採用する', () => {
    expect(entries.length).toBe(3);
    expect(entries[0].link).toBe('https://example.com/norel');
  });
  it('rel=self だけなら先頭の link へ寄せ、updated と content を使う', () => {
    expect(entries[1].link).toBe('https://example.com/feed.atom');
    expect(entries[1].publishedAt).toBe('2026-11-13T00:00:00.000Z');
    expect(entries[1].summary).toBe('内容だけ');
  });
  it('シングルクォートの属性も読める', () => {
    expect(entries[2].link).toBe('https://example.com/single');
  });
});

describe('parseFeedXml (ポッドキャスト: enclosure と duration)', () => {
  it('画像 enclosure より音声 enclosure を選ぶ', () => {
    const xml = `<rss version="2.0"><channel><item>
      <title>ep1</title><link>https://example.com/ep1</link>
      <enclosure url="https://example.com/cover.jpg" type="image/jpeg" length="100" />
      <enclosure url="https://example.com/ep1.mp3" type="audio/mpeg" length="200" />
    </item></channel></rss>`;
    const [entry] = parseFeedXml(xml, { id: 'pod' });
    expect(entry.audioUrl).toBe('https://example.com/ep1.mp3');
  });
  it('type の無い enclosure は音声拡張子の URL だけ採用する', () => {
    const xml = `<rss version="2.0"><channel>
      <item><title>mp3</title><link>https://example.com/a</link>
        <enclosure url="https://example.com/a.mp3?dl=1" length="10" /></item>
      <item><title>jpg</title><link>https://example.com/b</link>
        <enclosure url="https://example.com/b.jpg" length="10" /></item>
    </channel></rss>`;
    const entries = parseFeedXml(xml, { id: 'pod' });
    expect(entries[0].audioUrl).toBe('https://example.com/a.mp3?dl=1');
    expect(entries[1].audioUrl).toBe('');
  });
  it('enclosure が無ければ audioUrl は空で durationSec は null', () => {
    const [entry] = parseFeedXml(RSS2, { id: 'sample' });
    expect(entry.audioUrl).toBe('');
    expect(entry.durationSec).toBeNull();
  });
  it('itunes:duration を秒に変換する', () => {
    const xml = `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><item>
      <title>長さつき</title><link>https://example.com/d</link>
      <enclosure url="https://example.com/d.mp3" type="audio/mpeg" />
      <itunes:duration>1:02:03</itunes:duration>
    </item></channel></rss>`;
    const [entry] = parseFeedXml(xml, { id: 'pod' });
    expect(entry.durationSec).toBe(3723);
  });
  it('itunes:duration の整数秒 (reader-gas が出す形) も変換する', () => {
    const xml = `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><item>
      <title>整数秒</title><link>https://example.com/e</link>
      <enclosure url="https://example.com/e.m4a" type="audio/x-m4a" />
      <itunes:duration>104</itunes:duration>
    </item></channel></rss>`;
    const [entry] = parseFeedXml(xml, { id: 'pod' });
    expect(entry.durationSec).toBe(104);
    expect(entry.audioUrl).toBe('https://example.com/e.m4a');
  });
  it('itunes:duration の MM:SS 形式も変換する', () => {
    const xml = `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><item>
      <title>分秒</title><link>https://example.com/f</link>
      <enclosure url="https://example.com/f.mp3" type="audio/mpeg" />
      <itunes:duration>34:53</itunes:duration>
    </item></channel></rss>`;
    const [entry] = parseFeedXml(xml, { id: 'pod' });
    expect(entry.durationSec).toBe(2093);
  });
  it('Atom の rel="enclosure" リンクを音声にする', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:example.com,2026:pod</id>
    <title>Atomポッドキャスト</title>
    <link rel="alternate" href="https://example.com/ep" />
    <link rel="enclosure" type="audio/mpeg" href="https://example.com/ep.mp3" />
    <published>2026-11-14T00:00:00Z</published>
  </entry>
</feed>`;
    const [entry] = parseFeedXml(xml, { id: 'atom-pod' });
    expect(entry.link).toBe('https://example.com/ep');
    expect(entry.audioUrl).toBe('https://example.com/ep.mp3');
  });
});

describe('parseFeedMeta (フィード自体のタイトル)', () => {
  it('RSS 2.0 は channel のタイトルを返す (item のタイトルではない)', () => {
    expect(parseFeedMeta(RSS2)).toEqual({ title: 'サンプルニュース' });
  });
  it('Atom は feed のタイトルを返す (entry のタイトルではない)', () => {
    expect(parseFeedMeta(ATOM)).toEqual({ title: 'Atomブログ' });
  });
  it('RSS 1.0 / RDF は channel のタイトルを返す', () => {
    expect(parseFeedMeta(RDF)).toEqual({ title: 'RDFニュース' });
  });
  it('channel のタイトルが item より後ろにあっても取る', () => {
    const xml = `<rss version="2.0"><channel>
      <item><title>記事タイトル</title><link>https://example.com/1</link></item>
      <title>後置きチャンネル名</title>
    </channel></rss>`;
    expect(parseFeedMeta(xml).title).toBe('後置きチャンネル名');
  });
  it('channel にタイトルが無ければ item のタイトルは使わず空文字', () => {
    const xml = `<rss version="2.0"><channel>
      <item><title>記事だけ</title><link>https://example.com/1</link></item>
    </channel></rss>`;
    expect(parseFeedMeta(xml)).toEqual({ title: '' });
  });
  it('Atom で feed のタイトルが無ければ entry のタイトルは使わず空文字', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><id>tag:x,1</id><title>エントリだけ</title><link href="https://example.com/1" /></entry>
    </feed>`;
    expect(parseFeedMeta(xml)).toEqual({ title: '' });
  });
  it('壊れた入力・空入力では投げず空文字', () => {
    expect(parseFeedMeta('')).toEqual({ title: '' });
    expect(parseFeedMeta('not xml at all <<<')).toEqual({ title: '' });
    expect(parseFeedMeta('<html><head><title>ページ名</title></head></html>')).toEqual({ title: '' });
    expect(parseFeedMeta(null)).toEqual({ title: '' });
  });
});

describe('parseItunesDuration', () => {
  it('秒だけの表記', () => {
    expect(parseItunesDuration('3723')).toBe(3723);
  });
  it('MM:SS 表記', () => {
    expect(parseItunesDuration('34:53')).toBe(2093);
  });
  it('H:MM:SS 表記', () => {
    expect(parseItunesDuration('2:34:53')).toBe(9293);
  });
  it('解釈できない値は null', () => {
    expect(parseItunesDuration('abc')).toBeNull();
    expect(parseItunesDuration('')).toBeNull();
    expect(parseItunesDuration('1:2:3:4')).toBeNull();
    expect(parseItunesDuration(null)).toBeNull();
  });
});

describe('summarize', () => {
  it('既定では5000文字で切り詰める', () => {
    expect(summarize('あ'.repeat(6000)).length).toBe(5000);
  });
  it('旧上限 (500) を超える要約は全文を保持する', () => {
    expect(summarize('あ'.repeat(600))).toBe('あ'.repeat(600));
  });
  it('maxChars を渡すとその長さで切り詰める', () => {
    expect(summarize('<p>' + 'x'.repeat(100) + '</p>', 10)).toBe('x'.repeat(10));
  });
  it('短い文はそのまま返す', () => {
    expect(summarize('短い')).toBe('短い');
  });
  it('改行付きテキストは改行を保持する', () => {
    expect(summarize('1行目\n2行目\n3行目')).toBe('1行目\n2行目\n3行目');
  });
  it('改行以外の空白 (スペース・タブ) の連続は1つに詰める', () => {
    expect(summarize('a   b\t\tc')).toBe('a b c');
    expect(summarize('行頭の空白\n  次の行')).toBe('行頭の空白\n次の行');
  });
  it('改行コードを \\n に統一し、3つ以上の連続改行は2つに詰める', () => {
    expect(summarize('a\r\nb\rc')).toBe('a\nb\nc');
    expect(summarize('a\n\n\n\nb')).toBe('a\n\nb');
  });
  it('<br> と段落の区切りは改行になる', () => {
    expect(summarize('a<br>b')).toBe('a\nb');
    expect(summarize('<p>a</p><p>b</p>')).toBe('a\nb');
  });
});

describe('補助関数', () => {
  it('decodeXmlEntities は数値参照と名前付き参照を戻す', () => {
    expect(decodeXmlEntities('a &amp; b &lt;tag&gt; &#65;&#x42;')).toBe('a & b <tag> AB');
  });
  it('stripTags はエスケープされたタグも取り除き、段落の区切りは改行として残す', () => {
    expect(stripTags('&lt;p&gt;hello&lt;/p&gt;\n  world')).toBe('hello\n\nworld');
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

describe('分割実行版 (parseFeedXmlChunked / parseXmlChunked)', () => {
  it('同期版と完全に同じ結果を返す', async () => {
    for (const xml of [RSS2, ATOM, RDF]) {
      await expect(parseFeedXmlChunked(xml, { id: 'x' })).resolves.toEqual(parseFeedXml(xml, { id: 'x' }));
      const tree = await parseXmlChunked(xml);
      expect(JSON.stringify(tree)).toBe(JSON.stringify(parseXml(xml)));
    }
    await expect(parseFeedXmlChunked('', { id: 'x' })).resolves.toEqual([]);
  });
  it('大きい文書では、完了前にメインスレッドへ制御が返る', async () => {
    // 256KB ごとの yield を固定する。同期のまま進むと、先に登録した
    // 0ms タイマーはパース完了まで処理されない。
    const body = 'あ'.repeat(2000);
    const items = Array.from({ length: 300 }, (_, i) => (
      `<item><title>t${i}</title><link>https://example.com/${i}</link><description>${body}</description></item>`
    )).join('');
    const xml = `<rss version="2.0"><channel>${items}</channel></rss>`;
    expect(xml.length).toBeGreaterThan(512 * 1024);
    let resolved = false;
    let timerFiredBeforeResolve = false;
    setTimeout(() => { if (!resolved) timerFiredBeforeResolve = true; }, 0);
    const entries = await parseFeedXmlChunked(xml, { id: 'big' });
    resolved = true;
    expect(entries.length).toBe(300);
    expect(entries).toEqual(parseFeedXml(xml, { id: 'big' }));
    expect(timerFiredBeforeResolve).toBe(true);
  });
});

describe('isCompleteFeedXml', () => {
  it('閉じタグまで届いた文書だけを完全とする', () => {
    expect(isCompleteFeedXml('<rss><channel></channel></rss>')).toBe(true);
    expect(isCompleteFeedXml('<rss><channel></channel></rss>\n')).toBe(true);
    expect(isCompleteFeedXml('<feed></feed>')).toBe(true);
    expect(isCompleteFeedXml('<rss><channel><item></item>')).toBe(false);
    expect(isCompleteFeedXml('<rss><channel></channel>')).toBe(false);
    expect(isCompleteFeedXml('')).toBe(false);
    expect(isCompleteFeedXml(null)).toBe(false);
  });
});
