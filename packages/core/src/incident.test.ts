import { describe, expect, it } from 'vitest';

import {
  detectionDelaySeconds,
  describeCause,
  incidentDurationSeconds,
  isOngoing,
  overlapSeconds,
  totalDowntimeSeconds,
} from './incident.js';

const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const HOUR = 3_600_000;

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

describe('isOngoing', () => {
  it('ended_at が null なら継続中', () => {
    expect(isOngoing({ startedAt: at(-HOUR), endedAt: null })).toBe(true);
    expect(isOngoing({ startedAt: at(-HOUR), endedAt: at(0) })).toBe(false);
  });
});

describe('incidentDurationSeconds', () => {
  it('開始から終了までの秒数', () => {
    expect(incidentDurationSeconds({ startedAt: at(-2 * HOUR), endedAt: at(-HOUR) }, NOW)).toBe(
      3600,
    );
  });

  it('継続中なら「今まで」で数える', () => {
    expect(incidentDurationSeconds({ startedAt: at(-90 * 60_000), endedAt: null }, NOW)).toBe(5400);
  });

  it('負にはならない（時計のずれで終了が開始より前になっても）', () => {
    expect(incidentDurationSeconds({ startedAt: at(0), endedAt: at(-HOUR) }, NOW)).toBe(0);
  });
});

describe('overlapSeconds', () => {
  const windowStart = NOW - 24 * HOUR;

  it('期間に完全に含まれる障害は、その長さぶん', () => {
    expect(
      overlapSeconds({ startedAt: at(-3 * HOUR), endedAt: at(-2 * HOUR) }, windowStart, NOW),
    ).toBe(3600);
  });

  /**
   * 期間の外へはみ出したぶんを数えると、
   * 「7日前に始まって今も続いている障害」で7日間の稼働率が 0% になってしまう。
   */
  it('期間の前にはみ出したぶんは切り詰める', () => {
    expect(
      overlapSeconds({ startedAt: at(-30 * HOUR), endedAt: at(-23 * HOUR) }, windowStart, NOW),
    ).toBe(3600);
  });

  it('継続中の障害は期間の終わりまでで数える', () => {
    expect(overlapSeconds({ startedAt: at(-2 * HOUR), endedAt: null }, windowStart, NOW)).toBe(
      7200,
    );
  });

  it('期間の外で完結した障害は 0', () => {
    expect(
      overlapSeconds({ startedAt: at(-30 * HOUR), endedAt: at(-29 * HOUR) }, windowStart, NOW),
    ).toBe(0);
  });
});

describe('totalDowntimeSeconds', () => {
  it('期間内の障害を合算する', () => {
    const total = totalDowntimeSeconds(
      [
        { startedAt: at(-5 * HOUR), endedAt: at(-4 * HOUR) },
        { startedAt: at(-2 * HOUR), endedAt: at(-1.5 * HOUR) },
        // 期間の外
        { startedAt: at(-40 * HOUR), endedAt: at(-39 * HOUR) },
      ],
      NOW - 24 * HOUR,
      NOW,
    );
    expect(total).toBe(3600 + 1800);
  });

  it('障害が無ければ 0', () => {
    expect(totalDowntimeSeconds([], NOW - 24 * HOUR, NOW)).toBe(0);
  });
});

describe('detectionDelaySeconds', () => {
  /**
   * 閾値は誤検知を減らすが、そのぶん検知が遅れる。
   * 「大きいほど安全な設定」ではないことを、選ぶ時点で数字で見せるための関数。
   */
  it('閾値 1 なら遅れは無い', () => {
    expect(detectionDelaySeconds(300, 1)).toBe(0);
  });

  it('閾値 N の遅れは 間隔 × (N − 1)', () => {
    expect(detectionDelaySeconds(300, 2)).toBe(300);
    expect(detectionDelaySeconds(300, 3)).toBe(600);
    // 1時間間隔で閾値3 = 最大2時間気付けない
    expect(detectionDelaySeconds(3600, 3)).toBe(7200);
  });

  it('閾値が 0 以下でも 1 として扱う（判定側と揃える）', () => {
    expect(detectionDelaySeconds(300, 0)).toBe(0);
    expect(detectionDelaySeconds(300, -3)).toBe(0);
  });
});

describe('describeCause', () => {
  it('ステータスコードがあれば併記する', () => {
    expect(describeCause('status', 503)).toBe('ステータス異常（HTTP 503）');
    expect(describeCause('timeout', null)).toBe('タイムアウト');
  });
});
