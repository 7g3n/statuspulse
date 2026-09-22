/**
 * 監視対象 URL の検証と正規化。
 *
 * このツールは「ユーザーが入力した任意の URL に、サーバー側から HTTP リクエストを送る」
 * という、SSRF（Server-Side Request Forgery）そのものの形をしている。
 * 送信元が Cloudflare Workers なので社内ネットワークには到達しないが、
 * それは実行環境がたまたま守ってくれているだけで、設計として守っているわけではない。
 *
 * Phase 3 で公開ステータスページを出す以上、
 * 「自分以外の誰かが登録した URL」を踏む可能性は将来必ず出てくる。
 * 入口で弾く規則をここに集め、画面と DB の両方から同じ規則を使う。
 *
 * ホスト名だけを見る検証は DNS リバインディングを防げない
 * （登録時は公開 IP、チェック時は私有 IP を返す名前がありうる）。
 * この層で防げるのは「明らかに内部を指す入力」までで、そこは割り切っている。
 */

import { InvalidMonitorUrlError } from './errors.js';

const ALLOWED_PROTOCOLS = ['http:', 'https:'];

/** 名前として内部を指すことが明らかなホスト。 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  '::1',
  'metadata.google.internal',
]);

/** 到達先が内部になる IPv4 の範囲。 */
function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;

  const octets = parts.map((part) => Number(part));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;

  const [a, b] = octets as [number, number, number, number];

  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // ループバック
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // リンクローカル（クラウドのメタデータ endpoint を含む）
  if (a === 0) return true;
  return false;
}

function isPrivateIpv6(hostname: string): boolean {
  const inner = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (inner === '::1' || inner === '::') return true;
  if (inner.startsWith('fc') || inner.startsWith('fd')) return true; // ユニークローカル
  if (inner.startsWith('fe80')) return true; // リンクローカル
  return false;
}

/**
 * 入力された URL を検証し、正規化した文字列を返す。
 *
 * 正規化でやっていること:
 *   - 前後の空白を落とす
 *   - スキームが無ければ https:// を補う（人は https を省いて書く）
 *   - フラグメント（#以降）を落とす。サーバーへのリクエストには送られないため、
 *     残しておくと「設定した文字列」と「実際に叩く URL」がずれる
 *
 * 弾いているもの:
 *   - http / https 以外のスキーム
 *   - URL 内の認証情報（https://user:pass@example.com）。
 *     DB に平文で残り、画面にも出てしまう。監視のためにそこまで預かる必要はない
 *   - 内部を指すホスト名・IP アドレス
 */
export function normalizeMonitorUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new InvalidMonitorUrlError('URL を入力してください');
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InvalidMonitorUrlError('URL の形式が正しくありません');
  }

  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    throw new InvalidMonitorUrlError('http:// または https:// の URL を指定してください');
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw new InvalidMonitorUrlError('URL に認証情報を含めることはできません');
  }

  const hostname = url.hostname.toLowerCase();

  if (hostname.length === 0) {
    throw new InvalidMonitorUrlError('ホスト名が指定されていません');
  }

  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    isPrivateIpv4(hostname) ||
    isPrivateIpv6(hostname)
  ) {
    throw new InvalidMonitorUrlError(
      'インターネットから到達できないアドレス（localhost や私有 IP）は監視できません',
    );
  }

  url.hash = '';
  return url.toString();
}

/** 例外ではなく真偽値で欲しい場面のための薄い包み。zod の refine から使う。 */
export function isValidMonitorUrl(raw: string): boolean {
  try {
    normalizeMonitorUrl(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * 一覧に出すための短い表記。
 * スキームと末尾のスラッシュを落とす。表の幅が限られており、
 * どれも https:// で始まる列は情報量が無いため。
 */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
