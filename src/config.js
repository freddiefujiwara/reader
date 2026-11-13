// データAPI(reader-gas の /exec)のURL。
// ビルド時に CI がシークレット API の値で "<API>" を置換する(他のアプリと同じ方式)。
const RAW = '<API>';

export const API_URL = RAW.startsWith('http') ? RAW : '';

// Google Sign-In 用の OAuth 2.0 Web クライアントID。
// tweet / health と同じクライアント (公開リポジトリで公開済みの値)。
// 許可アカウントの判定はクライアント側では行わず、reader-gas が
// IDトークンの検証とメール確認をサーバー側で行う。
export const GOOGLE_CLIENT_ID =
  '728154182351-5ribj1diqcp8jpfo3rnqk9rei1aka98t.apps.googleusercontent.com';
