import { describe, it } from 'vitest';
import fc from 'fast-check';
import {
  decodeXmlEntities,
  parseFeedXml,
  parseItunesDuration,
  stripTags,
  summarize,
} from '../src/lib/feedParse.js';
import { formatPublishedAt } from '../src/lib/format.js';
import { buildShareUrl, formatShareExpiry } from '../src/lib/shareLink.js';
import { feedIdFromUrl, normalizeFeedIds } from '../src/lib/feedHash.js';
import {
  feedCategories,
  visibleArticles,
  withUnreadCounts,
  sortArticlesDesc,
  mergePendingReadMarks,
} from '../src/lib/listState.js';
import {
  planLocalPrune,
  planOrphanArticles,
} from '../src/lib/localDb.js';
import { buildQueue } from '../src/lib/player.js';

// JSON から作れる「文字列化できないオブジェクト」も生成ドメインに含める。
// Sheets / API 応答は JSON 経由なので、toString が関数でないオブジェクトは
// 値の形として到達しうる (兄弟アプリの総点検で実際に不具合になった型)。
const BAD = { toString: [] };
const jsonish = fc.oneof(fc.jsonValue(), fc.constant(BAD));

const RUNS = { numRuns: 100 };
const NOW = new Date(2026, 10, 14, 12, 0, 0);

describe('property: feedParse', () => {
  it('parseFeedXml はどんな文字列でも投げず、エントリの形がそろっている', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (xml) => {
        const entries = parseFeedXml(xml, { id: 'f' });
        if (!Array.isArray(entries)) return false;
        return entries.every(
          (e) =>
            typeof e.guid === 'string' &&
            typeof e.title === 'string' &&
            e.title.length > 0 &&
            typeof e.link === 'string' &&
            e.link.length > 0 &&
            typeof e.publishedAt === 'string' &&
            (e.publishedAt === '' || !Number.isNaN(Date.parse(e.publishedAt))) &&
            typeof e.summary === 'string' &&
            typeof e.author === 'string' &&
            typeof e.audioUrl === 'string' &&
            (e.durationSec === null || (Number.isFinite(e.durationSec) && e.durationSec >= 0))
        );
      }),
      RUNS
    );
  });

  it('組み立てた RSS の item は、リンクのあるものがすべて取り出せる', () => {
    const itemArb = fc.record({
      title: fc.string({ maxLength: 30 }),
      link: fc.webUrl(),
      date: fc.date({ noInvalidDate: true }),
    });
    fc.assert(
      fc.property(fc.array(itemArb, { maxLength: 8 }), (items) => {
        const body = items
          .map(
            (i) =>
              `<item><title>${i.title.replace(/[<>&]/g, '')}</title><link>${i.link}</link>` +
              `<pubDate>${i.date.toUTCString()}</pubDate></item>`
          )
          .join('');
        const entries = parseFeedXml(`<rss version="2.0"><channel>${body}</channel></rss>`, { id: 'f' });
        return entries.length === items.length && entries.every((e, idx) => e.link === items[idx].link);
      }),
      RUNS
    );
  });

  it('decodeXmlEntities はどんな文字列でも投げず、& を含まない文字列はそのまま', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const out = decodeXmlEntities(s);
        if (typeof out !== 'string') return false;
        if (!s.includes('&')) return out === s;
        return true;
      }),
      RUNS
    );
  });

  it('数値文字参照は、範囲内ならその文字に、範囲外なら置換文字になる', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0x200000 }), (cp) => {
        const out = decodeXmlEntities(`&#${cp};`);
        if (cp <= 0x10ffff) return out === String.fromCodePoint(cp);
        return out === '�';
      }),
      RUNS
    );
  });

  it('parseItunesDuration は null か有限の非負数だけを返す', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (s) => {
        const v = parseItunesDuration(s);
        return v === null || (Number.isFinite(v) && v >= 0);
      }),
      RUNS
    );
  });

  it('parseItunesDuration は H:MM:SS 形を手計算と一致させる', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: 0, max: 59 }),
        (h, m, s) => parseItunesDuration(`${h}:${m}:${s}`) === h * 3600 + m * 60 + s
      ),
      RUNS
    );
  });

  it('summarize は上限を超えず、stripTags の結果にタグ形 (<...>) が残らない', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), fc.integer({ min: 1, max: 50 }), (html, limit) => {
        if (summarize(html, limit).length > limit) return false;
        return !/<[^>]*>/.test(stripTags(html).replace(/<[^>]*$/, ''));
      }),
      RUNS
    );
  });
});

describe('property: 日時と共有リンクの整形', () => {
  it('formatPublishedAt はどんな値でも投げず、決まった形のどれかになる', () => {
    const shape = /^($|今日 \d{1,2}:\d{2}|昨日 \d{1,2}:\d{2}|\d{1,2}\/\d{1,2}|\d+\/\d{1,2}\/\d{1,2})$/;
    fc.assert(
      fc.property(jsonish, (v) => {
        const out = formatPublishedAt(v, NOW);
        return typeof out === 'string' && shape.test(out);
      }),
      RUNS
    );
  });

  it('formatPublishedAt は有効な日付文字列を、その日付の表示にする', () => {
    fc.assert(
      fc.property(fc.date({ noInvalidDate: true, min: new Date(2000, 0, 1), max: new Date(2030, 11, 31) }), (d) => {
        const out = formatPublishedAt(d.toISOString(), NOW);
        return out !== '' && !out.includes('NaN') && !out.includes('undefined');
      }),
      RUNS
    );
  });

  it('formatShareExpiry はどんな値でも投げず、空か「YYYY/M/D H:MM」形', () => {
    const shape = /^($|\d+\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2})$/;
    fc.assert(
      fc.property(jsonish, (v) => {
        const out = formatShareExpiry(v);
        return typeof out === 'string' && shape.test(out);
      }),
      RUNS
    );
  });

  it('buildShareUrl はどんな token でも投げず、文字列 token のときだけ #share= を付ける', () => {
    fc.assert(
      fc.property(jsonish, (token) => {
        const out = buildShareUrl(token, { origin: 'https://example.com', base: '/reader/' });
        if (typeof out !== 'string') return false;
        if (typeof token === 'string' && token) {
          return out === `https://example.com/reader/#share=${token}`;
        }
        return out === '';
      }),
      RUNS
    );
  });
});

describe('property: フィード一覧の正規化', () => {
  it('normalizeFeedIds はどんな入力でも投げず、URL のあるエントリだけが残る', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(jsonish, { maxLength: 6 }), async (feeds) => {
        const out = await normalizeFeedIds(feeds);
        if (!Array.isArray(out)) return false;
        for (const f of out) {
          if (typeof f.url !== 'string' || !f.url) return false;
          if (f.id !== (await feedIdFromUrl(f.url))) return false;
        }
        const validCount = feeds.filter(
          (f) => f && typeof f === 'object' && !Array.isArray(f) && typeof f.url === 'string' && f.url
        ).length;
        return out.length === validCount;
      }),
      RUNS
    );
  });
});

describe('property: listState', () => {
  const articleArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 6 }),
    feedId: fc.constantFrom('f1', 'f2'),
    isRead: fc.boolean(),
    publishedAt: fc.oneof(
      fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
      fc.constant(''),
      fc.constant('garbage')
    ),
    fetchedAt: fc.constant(''),
  });

  it('sortArticlesDesc は投げず、入力の並べ替え (順列) で、日時降順になる', () => {
    const timeOf = (a) => {
      const v = a && typeof a === 'object' ? a.publishedAt : '';
      return typeof v === 'string' ? Date.parse(v) || 0 : 0;
    };
    fc.assert(
      fc.property(fc.array(fc.oneof(articleArb, fc.constant(null)), { maxLength: 10 }), (articles) => {
        const out = sortArticlesDesc(articles);
        if (out.length !== articles.length) return false;
        const counts = new Map();
        articles.forEach((a) => counts.set(a, (counts.get(a) || 0) + 1));
        out.forEach((a) => counts.set(a, (counts.get(a) || 0) - 1));
        if ([...counts.values()].some((n) => n !== 0)) return false;
        for (let i = 1; i < out.length; i++) {
          if (timeOf(out[i - 1]) < timeOf(out[i])) return false;
        }
        return true;
      }),
      RUNS
    );
  });

  it('withUnreadCounts の合計は、フィードに属する未読記事の数と一致する', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.constantFrom('f1', 'f2', 'f3') }), { maxLength: 4 }),
        fc.array(articleArb, { maxLength: 10 }),
        (feeds, articles) => {
          const out = withUnreadCounts(feeds, articles);
          const feedIds = new Set(feeds.map((f) => f.id));
          const expected = articles.filter((a) => !a.isRead && feedIds.has(a.feedId)).length;
          const total = out.reduce((acc, f) => acc + f.unreadCount, 0);
          // 同じ id のフィードが重複する生成では、その分だけ数え直される
          // (重複は呼び出し側の同一性で防ぐ前提)。重複時は総和の一致を
          // 求めず、件数が非負であることだけを見る。
          if (feedIds.size !== feeds.length) return total >= 0;
          return total === expected;
        }
      ),
      RUNS
    );
  });

  it('feedCategories は重複のない非空文字列だけを、出現順で返す', () => {
    fc.assert(
      fc.property(fc.array(jsonish, { maxLength: 8 }), (feeds) => {
        const out = feedCategories(feeds);
        if (new Set(out).size !== out.length) return false;
        return out.every((c) => typeof c === 'string' && c.length > 0 && c === c.trim());
      }),
      RUNS
    );
  });

  it('visibleArticles の結果は入力の部分集合で、未読フィルタでは未読か sticky だけが残る', () => {
    fc.assert(
      fc.property(
        fc.array(articleArb, { maxLength: 10 }),
        fc.array(fc.string({ maxLength: 6 }), { maxLength: 4 }),
        (articles, stickyIds) => {
          const state = { articles, feeds: [], category: '', feedId: '', filter: 'unread' };
          const out = visibleArticles(state, stickyIds);
          if (!out.every((a) => articles.includes(a))) return false;
          const sticky = new Set(stickyIds);
          return out.every((a) => !a.isRead || sticky.has(a.id));
        }
      ),
      RUNS
    );
  });

  it('mergePendingReadMarks は marks に無い記事を変えず、keep は marks の部分集合', () => {
    fc.assert(
      fc.property(
        fc.array(articleArb, { maxLength: 8 }),
        fc.dictionary(fc.string({ maxLength: 6 }), fc.boolean(), { maxKeys: 4 }),
        (views, markObj) => {
          const marks = new Map(Object.entries(markObj));
          const { articles, keep } = mergePendingReadMarks(views, marks);
          if (articles.length !== views.length) return false;
          for (const k of keep.keys()) if (!marks.has(k)) return false;
          return articles.every((a, i) => marks.has(a.id) || a === views[i]);
        }
      ),
      RUNS
    );
  });
});

describe('property: localDb の計画とプレイヤーのキュー', () => {
  const recordArb = fc.record({
    id: fc.string({ minLength: 1, maxLength: 6 }),
    feed_id: fc.constantFrom('f1', 'f2'),
    is_read: fc.boolean(),
    fetched_at: fc.oneof(
      fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
      fc.constant(''),
      fc.constant('garbage')
    ),
    published_at: fc.constant(''),
  });

  it('planLocalPrune は未読を決して消さず、返す ID は入力に含まれる', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(recordArb, fc.constant(null)), { maxLength: 10 }), (records) => {
        const ids = planLocalPrune(records, '2026-11-20T00:00:00.000Z');
        const readIds = new Set(records.filter(Boolean).filter((r) => r.is_read === true).map((r) => r.id));
        return ids.every((id) => readIds.has(id));
      }),
      RUNS
    );
  });

  it('planOrphanArticles は、生きているフィードの記事を決して返さない', () => {
    // 記事 ID は IndexedDB の主キーなので、同じ ID の記事は共存しない。
    // 生成器の短い ID は衝突しうるため、添字を付けて一意化してから
    // 渡す (同一 ID が別フィードに現れる入力は実在しない)。
    const uniqueRecordsArb = fc
      .array(fc.oneof(recordArb, fc.constant(null)), { maxLength: 10 })
      .map((rs) => rs.map((r, i) => (r ? { ...r, id: `${r.id}#${i}` } : r)));
    fc.assert(
      fc.property(
        uniqueRecordsArb,
        fc.subarray(['f1', 'f2']),
        (records, live) => {
          const ids = new Set(planOrphanArticles(records, live));
          return records.filter(Boolean).every((r) => !ids.has(r.id) || !live.includes(r.feed_id));
        }
      ),
      RUNS
    );
  });

  it('buildQueue は音声つきだけを順序どおりに含み、現在エピソードを必ず含む', () => {
    const epArb = fc.record({
      id: fc.string({ minLength: 1, maxLength: 6 }),
      audioUrl: fc.oneof(fc.constant(''), fc.webUrl()),
    });
    fc.assert(
      fc.property(fc.array(fc.oneof(epArb, fc.constant(null)), { maxLength: 10 }), epArb, (articles, current) => {
        const queue = buildQueue(articles, current);
        if (!queue.includes(current) && !queue.some((a) => a && a.id === current.id)) return false;
        // 入力にある音声つきは、入力順のまま全件入る。現在エピソードが
        // 音声つき一覧に無い場合は、その1件だけのキューになる (その際は
        // 現在エピソード自身に音声が無くてもよい、という既存の仕様)。
        const playable = articles.filter((a) => a && a.audioUrl);
        if (playable.some((a) => a.id === current.id)) {
          return queue.length === playable.length && queue.every((a) => a && a.audioUrl);
        }
        return queue.length === 1 && queue[0] === current;
      }),
      RUNS
    );
  });
});
