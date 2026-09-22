import { describe, expect, it } from 'vitest';

import {
  buildClientHello,
  certificateAlertThreshold,
  certificateDedupeKey,
  certificateStatus,
  extractCertificateDer,
  formatDaysRemaining,
  parseAsn1Time,
  parseCertificate,
  CERTIFICATE_CRITICAL_DAYS,
  CERTIFICATE_WARNING_DAYS,
} from './tls.js';

/* -------------------------------------------------------------------------- */
/* DER を組み立てる補助（テスト用）                                            */
/* -------------------------------------------------------------------------- */

/** DER の1要素を作る。長さの短形式・長形式の両方を出し分ける。 */
function der(tag: number, ...contents: number[][]): number[] {
  const body = contents.flat();

  if (body.length < 0x80) return [tag, body.length, ...body];

  const lengthBytes: number[] = [];
  let remaining = body.length;
  while (remaining > 0) {
    lengthBytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return [tag, 0x80 | lengthBytes.length, ...lengthBytes, ...body];
}

function ascii(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

const SEQUENCE = 0x30;
const SET = 0x31;
const INTEGER = 0x02;
const OID = 0x06;
const UTF8_STRING = 0x0c;
const UTC_TIME = 0x17;
const GENERALIZED_TIME = 0x18;

function attribute(oid: number[], value: string): number[] {
  return der(SET, der(SEQUENCE, der(OID, oid), der(UTF8_STRING, ascii(value))));
}

/** 期限の解析に必要な部分だけを持つ、最小の証明書。 */
function buildCertificate(options: {
  notBefore: [number, string];
  notAfter: [number, string];
  organization?: string;
  commonName?: string;
  withVersion?: boolean;
}): Uint8Array {
  const issuerAttributes: number[][] = [];
  if (options.organization) {
    issuerAttributes.push(attribute([0x55, 0x04, 0x0a], options.organization));
  }
  if (options.commonName) {
    issuerAttributes.push(attribute([0x55, 0x04, 0x03], options.commonName));
  }

  const tbsFields: number[][] = [];
  if (options.withVersion !== false) tbsFields.push(der(0xa0, der(INTEGER, [0x02])));

  tbsFields.push(
    der(INTEGER, [0x01, 0x02, 0x03]), // serialNumber
    der(SEQUENCE, der(OID, [0x2a, 0x86, 0x48])), // signature
    der(SEQUENCE, ...issuerAttributes), // issuer
    der(
      SEQUENCE,
      der(options.notBefore[0], ascii(options.notBefore[1])),
      der(options.notAfter[0], ascii(options.notAfter[1])),
    ), // validity
    der(SEQUENCE, ...issuerAttributes), // subject
  );

  return new Uint8Array(
    der(
      SEQUENCE,
      der(SEQUENCE, ...tbsFields),
      der(SEQUENCE, der(OID, [0x2a, 0x86, 0x48])),
      der(0x03, [0x00, 0xff]),
    ),
  );
}

/* -------------------------------------------------------------------------- */

describe('buildClientHello', () => {
  const hello = buildClientHello('example.com', new Uint8Array(32));

  it('TLS レコード（handshake）として組み立てられている', () => {
    expect(hello[0]).toBe(0x16);
    expect(hello[1]).toBe(0x03);
    // レコード長が実体と一致する
    expect((hello[3]! << 8) | hello[4]!).toBe(hello.length - 5);
  });

  it('ClientHello で、宣言するバージョンが TLS 1.2 になっている', () => {
    expect(hello[5]).toBe(0x01); // handshake type: client_hello
    expect(hello[9]).toBe(0x03);
    expect(hello[10]).toBe(0x03); // TLS 1.2
  });

  it('SNI にホスト名が入っている（共有ホストで別の証明書を掴まないため）', () => {
    const text = new TextDecoder().decode(hello);
    expect(text).toContain('example.com');
  });

  /**
   * ここがこの実装の肝。supported_versions（0x002b）を送ると TLS 1.3 が選ばれ、
   * Certificate メッセージが暗号化されて読めなくなる。
   */
  it('supported_versions 拡張を送らない（TLS 1.3 を選ばせないため）', () => {
    let found = false;
    for (let i = 0; i < hello.length - 1; i += 1) {
      if (hello[i] === 0x00 && hello[i + 1] === 0x2b) found = true;
    }
    expect(found).toBe(false);
  });
});

describe('extractCertificateDer', () => {
  function record(type: number, payload: number[]): number[] {
    return [type, 0x03, 0x03, (payload.length >> 8) & 0xff, payload.length & 0xff, ...payload];
  }

  function handshakeMessage(type: number, body: number[]): number[] {
    return [
      type,
      (body.length >> 16) & 0xff,
      (body.length >> 8) & 0xff,
      body.length & 0xff,
      ...body,
    ];
  }

  const certificate = [0xaa, 0xbb, 0xcc, 0xdd];

  function certificateMessage(): number[] {
    const list = [0x00, 0x00, certificate.length, ...certificate];
    return handshakeMessage(0x0b, [
      (list.length >> 16) & 0xff,
      (list.length >> 8) & 0xff,
      list.length & 0xff,
      ...list,
    ]);
  }

  it('ServerHello のあとに続く Certificate から、先頭の証明書を取り出す', () => {
    const bytes = new Uint8Array([
      ...record(0x16, handshakeMessage(0x02, [0x03, 0x03])), // ServerHello
      ...record(0x16, certificateMessage()),
    ]);
    expect([...(extractCertificateDer(bytes) ?? [])]).toEqual(certificate);
  });

  /** レコードが複数に分かれて届いても、連結してから読む。 */
  it('複数のレコードにまたがっていても読める', () => {
    const message = certificateMessage();
    const half = Math.floor(message.length / 2);
    const bytes = new Uint8Array([
      ...record(0x16, message.slice(0, half)),
      ...record(0x16, message.slice(half)),
    ]);
    expect([...(extractCertificateDer(bytes) ?? [])]).toEqual(certificate);
  });

  it('まだ足りなければ null を返す（呼び出し側が読み足す）', () => {
    const bytes = new Uint8Array(record(0x16, handshakeMessage(0x02, [0x03, 0x03])));
    expect(extractCertificateDer(bytes)).toBeNull();
  });

  /** TLS 1.2 を拒否されたときはここに来る。黙って null を返すと原因が追えない。 */
  it('alert レコードを受け取ったら例外にする', () => {
    const bytes = new Uint8Array(record(0x15, [0x02, 0x46]));
    expect(() => extractCertificateDer(bytes)).toThrow(/alert/);
  });
});

describe('parseAsn1Time', () => {
  /**
   * RFC 5280: UTCTime の2桁の年は 50 以上が 19xx、49 以下が 20xx。
   * ここを取り違えると 70 年ずれる。
   */
  it('UTCTime の2桁の年を RFC 5280 の規則で解釈する', () => {
    expect(parseAsn1Time(0x17, '260922120000Z').getUTCFullYear()).toBe(2026);
    expect(parseAsn1Time(0x17, '490101000000Z').getUTCFullYear()).toBe(2049);
    expect(parseAsn1Time(0x17, '500101000000Z').getUTCFullYear()).toBe(1950);
    expect(parseAsn1Time(0x17, '990101000000Z').getUTCFullYear()).toBe(1999);
  });

  it('GeneralizedTime は4桁の年をそのまま使う', () => {
    const value = parseAsn1Time(0x18, '20260922123456Z');
    expect(value.toISOString()).toBe('2026-09-22T12:34:56.000Z');
  });

  it('秒が省略されていても読める', () => {
    expect(parseAsn1Time(0x17, '2609221200Z').toISOString()).toBe('2026-09-22T12:00:00.000Z');
  });
});

describe('parseCertificate', () => {
  it('有効期間と発行者を取り出す', () => {
    const certificate = buildCertificate({
      notBefore: [UTC_TIME, '260601000000Z'],
      notAfter: [UTC_TIME, '260830235959Z'],
      organization: "Let's Encrypt",
      commonName: 'R11',
    });

    const info = parseCertificate(certificate);
    expect(info.notBefore.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(info.notAfter.toISOString()).toBe('2026-08-30T23:59:59.000Z');
    // O を優先する（「R11」より伝わるため）
    expect(info.issuer).toBe("Let's Encrypt");
  });

  it('O が無ければ CN を使う', () => {
    const certificate = buildCertificate({
      notBefore: [UTC_TIME, '260601000000Z'],
      notAfter: [UTC_TIME, '260830235959Z'],
      commonName: 'Example CA',
    });
    expect(parseCertificate(certificate).issuer).toBe('Example CA');
  });

  it('version フィールドが無い証明書（v1）でも読める', () => {
    const certificate = buildCertificate({
      notBefore: [UTC_TIME, '260601000000Z'],
      notAfter: [UTC_TIME, '260830235959Z'],
      withVersion: false,
    });
    expect(parseCertificate(certificate).notAfter.getUTCFullYear()).toBe(2026);
  });

  it('GeneralizedTime を使う証明書でも読める', () => {
    const certificate = buildCertificate({
      notBefore: [GENERALIZED_TIME, '20260601000000Z'],
      notAfter: [GENERALIZED_TIME, '20510830235959Z'],
    });
    expect(parseCertificate(certificate).notAfter.getUTCFullYear()).toBe(2051);
  });

  /** 実際の証明書は 1KB 前後で、長さは必ず長形式になる。 */
  it('長さの長形式（2バイト以上）を扱える', () => {
    const certificate = buildCertificate({
      notBefore: [UTC_TIME, '260601000000Z'],
      notAfter: [UTC_TIME, '260830235959Z'],
      organization: 'X'.repeat(300),
    });
    expect(certificate.length).toBeGreaterThan(300);
    expect(parseCertificate(certificate).notAfter.getUTCFullYear()).toBe(2026);
  });

  it('壊れたバイト列は例外にする', () => {
    expect(() => parseCertificate(new Uint8Array([0x30, 0x02, 0x00, 0x00]))).toThrow();
  });
});

describe('期限の評価', () => {
  const NOW = Date.parse('2026-09-22T00:00:00.000Z');

  function inDays(days: number): string {
    return new Date(NOW + days * 86_400_000).toISOString();
  }

  it('残り日数で段階が変わる', () => {
    expect(certificateStatus(inDays(90), NOW)).toBe('ok');
    expect(certificateStatus(inDays(CERTIFICATE_WARNING_DAYS), NOW)).toBe('expiring');
    expect(certificateStatus(inDays(CERTIFICATE_CRITICAL_DAYS), NOW)).toBe('critical');
    expect(certificateStatus(inDays(-1), NOW)).toBe('expired');
    expect(certificateStatus(null, NOW)).toBe('unknown');
  });

  it('境界（30日ちょうど / 7日ちょうど / 0日）', () => {
    expect(certificateStatus(inDays(30.1), NOW)).toBe('ok');
    expect(certificateStatus(inDays(30), NOW)).toBe('expiring');
    expect(certificateStatus(inDays(7.1), NOW)).toBe('expiring');
    expect(certificateStatus(inDays(7), NOW)).toBe('critical');
    expect(certificateStatus(inDays(0), NOW)).toBe('expired');
  });

  /** 「あと1日」と出ている間に切れる、を避けるため切り捨てる。 */
  it('残り日数は切り捨てて表示する', () => {
    expect(formatDaysRemaining(inDays(9.9), NOW)).toBe('あと 9 日');
    expect(formatDaysRemaining(inDays(0.5), NOW)).toBe('24時間以内');
    expect(formatDaysRemaining(inDays(-1), NOW)).toBe('期限切れ');
    expect(formatDaysRemaining(null, NOW)).toBe('—');
  });

  it('通知の閾値は 30日 → 7日 の2段階だけ', () => {
    expect(certificateAlertThreshold(inDays(60), NOW)).toBeNull();
    expect(certificateAlertThreshold(inDays(20), NOW)).toBe(CERTIFICATE_WARNING_DAYS);
    expect(certificateAlertThreshold(inDays(3), NOW)).toBe(CERTIFICATE_CRITICAL_DAYS);
    expect(certificateAlertThreshold(inDays(-5), NOW)).toBe(CERTIFICATE_CRITICAL_DAYS);
  });

  /**
   * 鍵に証明書の期限そのものを含めるのが要点。
   * 更新されれば鍵が変わるので次の通知が届き、更新されない限り二度は鳴らない。
   */
  it('重複を防ぐ鍵は、証明書が更新されたときだけ変わる', () => {
    const a = certificateDedupeKey('m1', inDays(20), 30);
    const b = certificateDedupeKey('m1', inDays(20), 30);
    const renewed = certificateDedupeKey('m1', inDays(100), 30);
    const escalated = certificateDedupeKey('m1', inDays(20), 7);

    expect(a).toBe(b);
    expect(a).not.toBe(renewed);
    // 30日の通知と7日の通知は別（同じ証明書でも2回鳴らす）
    expect(a).not.toBe(escalated);
  });
});
