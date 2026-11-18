import { describe, it, expect } from 'vitest';
import {
  buildXShareUrl,
  buildFacebookShareUrl,
  buildThreadsShareUrl,
} from '../src/lib/shareArticle.js';

const LINK = 'https://www.youtube.com/watch?v=abc123XYZ';
const TITLE = 'ヨルシカ - 茜（OFFICIAL VIDEO）';

describe('buildXShareUrl', () => {
  it('タイトルとリンクを intent URL に入れる', () => {
    expect(buildXShareUrl(TITLE, LINK)).toBe(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(TITLE)}&url=${encodeURIComponent(LINK)}`
    );
  });
  it('リンクのクエリ文字列もエンコードする', () => {
    const link = 'https://example.com/article?id=1&lang=ja';
    expect(buildXShareUrl('タイトル', link)).toBe(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent('タイトル')}&url=${encodeURIComponent(link)}`
    );
  });
  it('リンクが無ければ空文字', () => {
    expect(buildXShareUrl(TITLE, '')).toBe('');
    expect(buildXShareUrl(TITLE, null)).toBe('');
    expect(buildXShareUrl(TITLE, undefined)).toBe('');
  });
  it('タイトルが無くてもリンクだけで作る', () => {
    expect(buildXShareUrl('', LINK)).toBe(
      `https://twitter.com/intent/tweet?text=&url=${encodeURIComponent(LINK)}`
    );
  });
});

describe('buildFacebookShareUrl', () => {
  it('リンクを sharer URL に入れる', () => {
    expect(buildFacebookShareUrl(LINK)).toBe(
      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(LINK)}`
    );
  });
  it('リンクが無ければ空文字', () => {
    expect(buildFacebookShareUrl('')).toBe('');
    expect(buildFacebookShareUrl(null)).toBe('');
  });
});

describe('buildThreadsShareUrl', () => {
  it('タイトルとリンクを改行でつないで text に入れる', () => {
    expect(buildThreadsShareUrl(TITLE, LINK)).toBe(
      `https://www.threads.net/intent/post?text=${encodeURIComponent(`${TITLE}\n${LINK}`)}`
    );
  });
  it('タイトルが無ければリンクだけを入れる', () => {
    expect(buildThreadsShareUrl('', LINK)).toBe(
      `https://www.threads.net/intent/post?text=${encodeURIComponent(LINK)}`
    );
  });
  it('リンクが無ければ空文字', () => {
    expect(buildThreadsShareUrl(TITLE, '')).toBe('');
    expect(buildThreadsShareUrl(TITLE, null)).toBe('');
  });
});
