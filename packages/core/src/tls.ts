/**
 * TLS 証明書の取得と解析（Phase 4）。
 *
 * **なぜ自前で解析しているのか**
 *   Cloudflare Workers の `fetch()` は相手の証明書を見せてくれない。
 *   Node の `tls` モジュールも Workers には無い。
 *   つまり「証明書の期限を知る」手段が、この実行環境には用意されていない。
 *
 *   残る道は `cloudflare:sockets` の `connect()` で生の TCP を開き、
 *   TLS のハンドシェイクを自分で始めて、サーバーが返す Certificate メッセージを
 *   読むこと。このモジュールはその組み立てと解析を担う。
 *
 * **TLS 1.3 ではなく 1.2 を使う理由**
 *   TLS 1.3 では Certificate メッセージが暗号化されるため、鍵交換まで実装しないと
 *   読めない。TLS 1.2 では平文で送られてくる。
 *   TLS 1.3 は `supported_versions` 拡張がある場合にのみ選ばれるので、
 *   その拡張を送らなければサーバーは 1.2 以下を選ぶ。
 *
 *   証明書そのものはバージョンによらず同じものが提示されるので、
 *   期限を知る目的ではこれで足りる。
 *
 * **この方法の限界**（docs/decisions.md の判断 33 に記載）
 *   - TLS 1.2 を完全に無効化したサーバーからは取得できない
 *   - 取得できるのは「提示された証明書の期限」だけで、
 *     チェーンの検証や失効の確認はしていない（それは fetch 側が行う）
 *
 * ここにあるのはすべて純粋関数で、ソケットには触れない。
 * バイト列の組み立てと解析だけなので、ネットワーク無しで検証できる。
 */

/* -------------------------------------------------------------------------- */
/* ClientHello の組み立て                                                      */
/* -------------------------------------------------------------------------- */

/**
 * TLS 1.2 の暗号スイート。
 *
 * サーバーがどれか1つを選べればよく、ハンドシェイクを完了させる必要はない
 * （Certificate を受け取った時点で目的は果たされ、こちらから接続を閉じる）。
 * 広く有効になっているものを、鍵種別（RSA / ECDSA）の両方について並べてある。
 */
const CIPHER_SUITES = [
  0xc02f, // ECDHE-RSA-AES128-GCM-SHA256
  0xc030, // ECDHE-RSA-AES256-GCM-SHA384
  0xc02b, // ECDHE-ECDSA-AES128-GCM-SHA256
  0xc02c, // ECDHE-ECDSA-AES256-GCM-SHA384
  0x009c, // AES128-GCM-SHA256
  0x002f, // AES128-SHA
  0x0035, // AES256-SHA
];

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u24(value: number): number[] {
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function extension(type: number, body: number[]): number[] {
  return [...u16(type), ...u16(body.length), ...body];
}

/**
 * ClientHello を1つの TLS レコードとして組み立てる。
 *
 * random は暗号学的な意味を持たない（鍵交換まで進まないため）が、
 * 固定値にするとサーバー側の実装によっては再送とみなされうるので乱数を入れる。
 */
export function buildClientHello(serverName: string, random?: Uint8Array): Uint8Array {
  const host = new TextEncoder().encode(serverName);

  const clientRandom = random ?? crypto.getRandomValues(new Uint8Array(32));
  if (clientRandom.length !== 32) throw new Error('client random must be 32 bytes');

  // server_name: SNI が無いと、共有ホストでは別の証明書が返る。
  const serverNameExt = extension(0x0000, [
    ...u16(host.length + 3),
    0x00, // host_name
    ...u16(host.length),
    ...host,
  ]);

  // supported_groups: ECDHE を選ばせるために要る。
  const supportedGroups = extension(0x000a, [
    ...u16(6),
    ...u16(0x001d), // x25519
    ...u16(0x0017), // secp256r1
    ...u16(0x0018), // secp384r1
  ]);

  const ecPointFormats = extension(0x000b, [0x01, 0x00]); // uncompressed

  const signatureAlgorithms = extension(0x000d, [
    ...u16(12),
    ...u16(0x0403), // ecdsa_secp256r1_sha256
    ...u16(0x0503), // ecdsa_secp384r1_sha384
    ...u16(0x0804), // rsa_pss_rsae_sha256
    ...u16(0x0401), // rsa_pkcs1_sha256
    ...u16(0x0501), // rsa_pkcs1_sha384
    ...u16(0x0201), // rsa_pkcs1_sha1
  ]);

  // supported_versions は**送らない**。送ると TLS 1.3 が選ばれ、
  // Certificate メッセージが暗号化されて読めなくなる。
  const extensions = [
    ...serverNameExt,
    ...supportedGroups,
    ...ecPointFormats,
    ...signatureAlgorithms,
  ];

  const body = [
    ...u16(0x0303), // client_version: TLS 1.2
    ...clientRandom,
    0x00, // session_id: 空
    ...u16(CIPHER_SUITES.length * 2),
    ...CIPHER_SUITES.flatMap(u16),
    0x01,
    0x00, // compression_methods: null のみ
    ...u16(extensions.length),
    ...extensions,
  ];

  const handshake = [0x01, ...u24(body.length), ...body];

  return new Uint8Array([
    0x16, // handshake
    0x03,
    0x01, // legacy_record_version
    ...u16(handshake.length),
    ...handshake,
  ]);
}

/* -------------------------------------------------------------------------- */
/* レコード層 → Certificate メッセージ                                          */
/* -------------------------------------------------------------------------- */

/**
 * 受け取ったバイト列から、サーバー証明書（チェーンの先頭）の DER を取り出す。
 *
 * 十分なバイトがまだ届いていなければ null を返す。呼び出し側は読み足して再試行する。
 * 途中で alert レコード（0x15）を受け取った場合は例外にする
 * （TLS 1.2 を拒否された、SNI が解決できなかった、などが該当する）。
 */
export function extractCertificateDer(bytes: Uint8Array): Uint8Array | null {
  // --- レコード層をほどいて handshake の中身だけを連結する ---
  const handshakeChunks: Uint8Array[] = [];
  let offset = 0;

  while (offset + 5 <= bytes.length) {
    const type = bytes[offset]!;
    const length = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
    const end = offset + 5 + length;

    if (type === 0x15) {
      throw new Error('TLS alert を受信しました（TLS 1.2 が拒否された可能性があります）');
    }
    if (end > bytes.length) break; // レコードが途中までしか届いていない
    if (type === 0x16) handshakeChunks.push(bytes.subarray(offset + 5, end));

    offset = end;
  }

  const handshake = concat(handshakeChunks);

  // --- handshake メッセージを歩いて Certificate(11) を探す ---
  let cursor = 0;
  while (cursor + 4 <= handshake.length) {
    const messageType = handshake[cursor]!;
    const length = readU24(handshake, cursor + 1);
    const bodyStart = cursor + 4;
    const bodyEnd = bodyStart + length;

    if (bodyEnd > handshake.length) return null; // まだ全部届いていない

    if (messageType === 0x0b) {
      // Certificate: cert_list_length(3) + [cert_length(3) + der] ...
      if (length < 6) return null;
      const firstCertLength = readU24(handshake, bodyStart + 3);
      const certStart = bodyStart + 6;
      if (certStart + firstCertLength > handshake.length) return null;
      return handshake.subarray(certStart, certStart + firstCertLength);
    }

    cursor = bodyEnd;
  }

  return null;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    result.set(chunk, at);
    at += chunk.length;
  }
  return result;
}

function readU24(bytes: Uint8Array, at: number): number {
  return (bytes[at]! << 16) | (bytes[at + 1]! << 8) | bytes[at + 2]!;
}

/* -------------------------------------------------------------------------- */
/* X.509 (DER) の解析                                                          */
/* -------------------------------------------------------------------------- */

type Tlv = {
  tag: number;
  /** 中身の開始位置（タグと長さを除いた先頭）。 */
  start: number;
  end: number;
};

/** DER の1要素を読む。長さの短形式・長形式の両方に対応する。 */
function readTlv(bytes: Uint8Array, at: number): Tlv {
  const tag = bytes[at];
  if (tag === undefined) throw new Error('DER: タグが読めません');

  const first = bytes[at + 1];
  if (first === undefined) throw new Error('DER: 長さが読めません');

  if (first < 0x80) {
    return { tag, start: at + 2, end: at + 2 + first };
  }

  const lengthBytes = first & 0x7f;
  if (lengthBytes === 0 || lengthBytes > 4) {
    throw new Error('DER: 扱えない長さ形式です');
  }

  let length = 0;
  for (let i = 0; i < lengthBytes; i += 1) {
    const byte = bytes[at + 2 + i];
    if (byte === undefined) throw new Error('DER: 長さが途中で切れています');
    length = length * 256 + byte;
  }

  const start = at + 2 + lengthBytes;
  return { tag, start, end: start + length };
}

/** ある要素の中身を、子要素の並びとして読む。 */
function children(bytes: Uint8Array, parent: Tlv): Tlv[] {
  const result: Tlv[] = [];
  let at = parent.start;
  while (at < parent.end) {
    const tlv = readTlv(bytes, at);
    result.push(tlv);
    at = tlv.end;
  }
  return result;
}

/**
 * ASN.1 の時刻を Date にする。
 *
 * UTCTime（YYMMDDHHMMSSZ）と GeneralizedTime（YYYYMMDDHHMMSSZ）の2種類がある。
 * UTCTime の2桁の年は RFC 5280 で「50 以上は 19xx、49 以下は 20xx」と決まっている。
 * 証明書の期限を扱う以上、ここを取り違えると 70 年ずれる。
 */
export function parseAsn1Time(tag: number, text: string): Date {
  const isUtcTime = tag === 0x17;
  const digits = text.replace(/[^0-9]/g, '');

  let year: number;
  let rest: string;

  if (isUtcTime) {
    const twoDigit = Number(digits.slice(0, 2));
    year = twoDigit >= 50 ? 1900 + twoDigit : 2000 + twoDigit;
    rest = digits.slice(2);
  } else {
    year = Number(digits.slice(0, 4));
    rest = digits.slice(4);
  }

  const month = Number(rest.slice(0, 2));
  const day = Number(rest.slice(2, 4));
  const hour = Number(rest.slice(4, 6));
  const minute = Number(rest.slice(6, 8));
  const second = Number(rest.slice(8, 10) || '0');

  const value = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(value)) throw new Error('DER: 時刻の形式が不正です');
  return new Date(value);
}

/** 属性の OID。発行者名の表示に使う2つだけを見る。 */
const OID_COMMON_NAME = [0x55, 0x04, 0x03];
const OID_ORGANIZATION = [0x55, 0x04, 0x0a];

function matchesOid(bytes: Uint8Array, tlv: Tlv, oid: readonly number[]): boolean {
  if (tlv.end - tlv.start !== oid.length) return false;
  return oid.every((byte, index) => bytes[tlv.start + index] === byte);
}

/**
 * 発行者名から表示用の1行を作る。
 *
 * O（組織名）を優先し、無ければ CN を使う。
 * 「Let's Encrypt」の方が「R11」より、受け取った人に伝わるため。
 */
function readIssuerName(bytes: Uint8Array, issuer: Tlv): string | null {
  const decoder = new TextDecoder();
  let commonName: string | null = null;
  let organization: string | null = null;

  for (const rdn of children(bytes, issuer)) {
    for (const attribute of children(bytes, rdn)) {
      const parts = children(bytes, attribute);
      const oid = parts[0];
      const value = parts[1];
      if (!oid || !value) continue;

      const text = decoder.decode(bytes.subarray(value.start, value.end));
      if (matchesOid(bytes, oid, OID_ORGANIZATION)) organization ??= text;
      if (matchesOid(bytes, oid, OID_COMMON_NAME)) commonName ??= text;
    }
  }

  return organization ?? commonName;
}

export type CertificateInfo = {
  notBefore: Date;
  notAfter: Date;
  issuer: string | null;
};

/**
 * 証明書（DER）から有効期間と発行者を取り出す。
 *
 * 構造（RFC 5280）:
 *   Certificate ::= SEQUENCE {
 *     tbsCertificate SEQUENCE {
 *       [0] version OPTIONAL,   ← あれば読み飛ばす
 *       serialNumber INTEGER,
 *       signature    SEQUENCE,
 *       issuer       SEQUENCE,  ← ここ
 *       validity     SEQUENCE { notBefore, notAfter },  ← ここ
 *       ...
 *
 * 必要なのは先頭4つだけなので、それ以降は読まない。
 * 拡張領域まで解析しても、この用途では使い道が無い。
 */
export function parseCertificate(der: Uint8Array): CertificateInfo {
  const certificate = readTlv(der, 0);
  const parts = children(der, certificate);
  const tbs = parts[0];
  if (!tbs) throw new Error('証明書の構造が不正です（tbsCertificate が無い）');

  let fields = children(der, tbs);

  // [0] EXPLICIT version（tag 0xa0）。v1 の証明書には無い。
  if (fields[0]?.tag === 0xa0) fields = fields.slice(1);

  const issuer = fields[2];
  const validity = fields[3];
  if (!issuer || !validity) throw new Error('証明書の構造が不正です（validity が無い）');

  const times = children(der, validity);
  const notBefore = times[0];
  const notAfter = times[1];
  if (!notBefore || !notAfter) throw new Error('証明書の構造が不正です（有効期間が読めない）');

  const decoder = new TextDecoder();

  return {
    notBefore: parseAsn1Time(
      notBefore.tag,
      decoder.decode(der.subarray(notBefore.start, notBefore.end)),
    ),
    notAfter: parseAsn1Time(
      notAfter.tag,
      decoder.decode(der.subarray(notAfter.start, notAfter.end)),
    ),
    issuer: readIssuerName(der, issuer),
  };
}

/* -------------------------------------------------------------------------- */
/* 期限の評価                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 通知と表示の閾値（日）。
 *
 * 30日: Let's Encrypt の自動更新は残り30日で走る。ここを過ぎても更新されないなら、
 *       自動更新そのものが壊れている可能性が高い。
 * 7日:  手で直すなら、この時点では動き始めていないと間に合わない。
 *
 * 2段階にしているのは、1段階だと「気付いたが後回しにした」まま期限が来るため。
 */
export const CERTIFICATE_WARNING_DAYS = 30;
export const CERTIFICATE_CRITICAL_DAYS = 7;

export type CertificateStatus = 'ok' | 'expiring' | 'critical' | 'expired' | 'unknown';

export function daysUntil(expiresAt: string | null, now: number = Date.now()): number | null {
  if (expiresAt === null) return null;
  return (Date.parse(expiresAt) - now) / 86_400_000;
}

export function certificateStatus(
  expiresAt: string | null,
  now: number = Date.now(),
): CertificateStatus {
  const days = daysUntil(expiresAt, now);
  if (days === null) return 'unknown';
  if (days <= 0) return 'expired';
  if (days <= CERTIFICATE_CRITICAL_DAYS) return 'critical';
  if (days <= CERTIFICATE_WARNING_DAYS) return 'expiring';
  return 'ok';
}

export const CERTIFICATE_STATUS_LABELS: Record<CertificateStatus, string> = {
  ok: '有効',
  expiring: '期限が近い',
  critical: 'まもなく期限切れ',
  expired: '期限切れ',
  unknown: '未確認',
};

/** 残り日数の表示。切り捨てる（「あと1日」と出ている間に切れる、を避ける）。 */
export function formatDaysRemaining(expiresAt: string | null, now: number = Date.now()): string {
  const days = daysUntil(expiresAt, now);
  if (days === null) return '—';
  if (days <= 0) return '期限切れ';
  if (days < 1) return '24時間以内';
  return `あと ${Math.floor(days)} 日`;
}

/**
 * 通知を出すべき閾値。
 *
 * 戻り値を「日数」にしているのは、通知の重複判定の鍵に使うため。
 * 鍵に証明書の期限そのものを含めるので、証明書が更新されれば鍵が変わり、
 * 次の更新までの間は同じ通知が二度出ない（Phase 2 と同じ考え方）。
 */
export function certificateAlertThreshold(
  expiresAt: string | null,
  now: number = Date.now(),
): number | null {
  const days = daysUntil(expiresAt, now);
  if (days === null) return null;
  if (days <= CERTIFICATE_CRITICAL_DAYS) return CERTIFICATE_CRITICAL_DAYS;
  if (days <= CERTIFICATE_WARNING_DAYS) return CERTIFICATE_WARNING_DAYS;
  return null;
}

export function certificateDedupeKey(
  monitorId: string,
  expiresAt: string,
  thresholdDays: number,
): string {
  return `certificate_expiring:${monitorId}:${expiresAt}:${thresholdDays}`;
}
