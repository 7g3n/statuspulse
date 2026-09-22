import { describe, expect, it } from 'vitest';

import {
  isStatusStale,
  publicState,
  statusPagePath,
  statusPageUrl,
  type PublicStatus,
} from './status-page.js';

const NOW = Date.parse('2026-09-22T12:00:00.000Z');

function status(overrides: Partial<PublicStatus> = {}): PublicStatus {
  return {
    title: 'StockDesk',
    description: '',
    status: 'up',
    status_changed_at: null,
    interval_seconds: 300,
    last_checked_at: new Date(NOW - 60_000).toISOString(),
    generated_at: new Date(NOW).toISOString(),
    uptime: {
      day: { window_seconds: 86400, down_seconds: 0 },
      week: { window_seconds: 604800, down_seconds: 0 },
    },
    checks: [],
    incidents: [],
    ...overrides,
  };
}

describe('statusPageUrl', () => {
  it('slug から公開ページの URL を組み立てる', () => {
    expect(statusPagePath('abc123')).toBe('/status/abc123');
    expect(statusPageUrl('https://status.example.com', 'abc123')).toBe(
      'https://status.example.com/status/abc123',
    );
  });

  it('末尾のスラッシュが二重にならない', () => {
    expect(statusPageUrl('https://status.example.com/', 'abc123')).toBe(
      'https://status.example.com/status/abc123',
    );
  });
});

describe('isStatusStale', () => {
  /**
   * 公開ページで最も避けたいのは、定期処理が止まっているのに
   * 「正常」と出し続けること。見に来た人はそれ以上確かめない。
   */
  it('間隔の3倍を超えて更新が無ければ古いとみなす', () => {
    expect(
      isStatusStale(status({ last_checked_at: new Date(NOW - 900_000).toISOString() }), NOW),
    ).toBe(false);
    expect(
      isStatusStale(status({ last_checked_at: new Date(NOW - 901_000).toISOString() }), NOW),
    ).toBe(true);
  });

  /** 1回の取りこぼしや Cron のゆらぎで「確認中」が出ないよう、3倍の余裕を取っている。 */
  it('1回ぶんの取りこぼしでは古いとみなさない', () => {
    expect(
      isStatusStale(status({ last_checked_at: new Date(NOW - 600_000).toISOString() }), NOW),
    ).toBe(false);
  });

  it('一度もチェックされていなければ古い扱い', () => {
    expect(isStatusStale(status({ last_checked_at: null }), NOW)).toBe(true);
  });
});

describe('publicState', () => {
  it('新しい結果があれば、そのまま状態を反映する', () => {
    expect(publicState(status({ status: 'up' }), NOW)).toBe('operational');
    expect(publicState(status({ status: 'down' }), NOW)).toBe('outage');
    expect(publicState(status({ status: 'unknown' }), NOW)).toBe('unknown');
  });

  /** 情報が古いときに「正常」と言い切らないのが、この関数の存在理由。 */
  it('結果が古ければ、正常でも「確認中」に落とす', () => {
    const stale = status({ status: 'up', last_checked_at: new Date(NOW - 7200_000).toISOString() });
    expect(publicState(stale, NOW)).toBe('unknown');
  });

  it('結果が古くても、落ちている表示は落ちているままにする', () => {
    const stale = status({
      status: 'down',
      last_checked_at: new Date(NOW - 7200_000).toISOString(),
    });
    // 「障害中だが情報が古い」は「確認中」に寄せる。
    // 直っているのに落ちていると言い続けるのも、同じ種類の嘘になるため。
    expect(publicState(stale, NOW)).toBe('unknown');
  });
});
