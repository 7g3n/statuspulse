import { describe, expect, it } from 'vitest';

import {
  checkCoverage,
  expectedCheckCount,
  formatResponseTime,
  formatUptimePercent,
  gradeUptime,
  isCoverageReliable,
  uptimeRatio,
  WINDOW_SECONDS,
} from './uptime.js';

describe('uptimeRatio', () => {
  it('成功回数 ÷ 全体を返す', () => {
    expect(uptimeRatio({ total: 100, up: 99 })).toBeCloseTo(0.99);
    expect(uptimeRatio({ total: 2016, up: 2016 })).toBe(1);
  });

  /** 「0% 稼働」と「まだデータがない」はまったく違う話なので、0 ではなく null を返す。 */
  it('チェックが1回も無ければ null（0 ではない）', () => {
    expect(uptimeRatio({ total: 0, up: 0 })).toBeNull();
  });

  it('全部失敗していれば 0', () => {
    expect(uptimeRatio({ total: 10, up: 0 })).toBe(0);
  });
});

describe('formatUptimePercent', () => {
  /**
   * この関数で最も重要な性質。
   * 10000 回中 1 回落ちていれば 99.99%。四捨五入すると小数第1位で 100.0% になり、
   * 「落ちた事実があるのに 100% と表示される」状態が生まれる。
   */
  it('切り上げない（落ちた事実があるのに 100% と表示しない）', () => {
    expect(formatUptimePercent(0.99999, 2)).toBe('99.99');
    expect(formatUptimePercent(0.9999, 1)).toBe('99.9');
    expect(formatUptimePercent(0.99996, 4)).toBe('99.9960');
  });

  it('100% と表示するのは失敗が1回も無かったときだけ', () => {
    expect(formatUptimePercent(1, 2)).toBe('100.00');
    expect(formatUptimePercent(1, 0)).toBe('100');
  });

  it('データが無ければダッシュを返す', () => {
    expect(formatUptimePercent(null)).toBe('—');
  });

  it('桁数を指定できる', () => {
    expect(formatUptimePercent(0.9955, 2)).toBe('99.55');
    expect(formatUptimePercent(0.9955, 1)).toBe('99.5');
    expect(formatUptimePercent(0.5, 2)).toBe('50.00');
  });
});

describe('gradeUptime', () => {
  it('99.9% 以上は healthy（月あたり約43分の停止まで）', () => {
    expect(gradeUptime(1)).toBe('healthy');
    expect(gradeUptime(0.999)).toBe('healthy');
  });

  it('99.9% 未満 99% 以上は degraded', () => {
    expect(gradeUptime(0.9989)).toBe('degraded');
    expect(gradeUptime(0.99)).toBe('degraded');
  });

  it('99% 未満は critical', () => {
    expect(gradeUptime(0.9899)).toBe('critical');
    expect(gradeUptime(0)).toBe('critical');
  });

  it('データが無ければ unknown', () => {
    expect(gradeUptime(null)).toBe('unknown');
  });
});

describe('expectedCheckCount', () => {
  it('期間を間隔で割った回数', () => {
    expect(expectedCheckCount(300, WINDOW_SECONDS.day)).toBe(288);
    expect(expectedCheckCount(60, WINDOW_SECONDS.day)).toBe(1440);
    expect(expectedCheckCount(300, WINDOW_SECONDS.week)).toBe(2016);
  });

  it('間隔が 0 以下なら 0（ゼロ除算を呼び出し側に押し付けない）', () => {
    expect(expectedCheckCount(0, WINDOW_SECONDS.day)).toBe(0);
    expect(expectedCheckCount(-1, WINDOW_SECONDS.day)).toBe(0);
  });
});

describe('checkCoverage', () => {
  /**
   * 稼働率の分母は「実行できたチェック」しか数えない。
   * Worker が止まっていた時間は分母からも消えるので、稼働率は実態より良く出る。
   * その取りこぼしを検出するのがこの関数の役割。
   */
  it('期待回数に対する実測回数の比を返す', () => {
    const coverage = checkCoverage(144, 300, WINDOW_SECONDS.day);
    expect(coverage.expected).toBe(288);
    expect(coverage.actual).toBe(144);
    expect(coverage.ratio).toBeCloseTo(0.5);
  });

  /** due 判定の許容幅により、期待をわずかに上回ることがある。105% と出しても意味がない。 */
  it('1 を超えないように頭打ちにする', () => {
    expect(checkCoverage(300, 300, WINDOW_SECONDS.day).ratio).toBe(1);
  });

  it('期待回数が 0 なら比は null', () => {
    expect(checkCoverage(0, 0, WINDOW_SECONDS.day).ratio).toBeNull();
  });
});

describe('isCoverageReliable', () => {
  it('期待の9割を超えていれば稼働率をそのまま信じてよい', () => {
    expect(isCoverageReliable(checkCoverage(288, 300, WINDOW_SECONDS.day))).toBe(true);
    expect(isCoverageReliable(checkCoverage(260, 300, WINDOW_SECONDS.day))).toBe(true);
  });

  it('9割を下回ったら分母が欠けている可能性があるとみなす', () => {
    expect(isCoverageReliable(checkCoverage(200, 300, WINDOW_SECONDS.day))).toBe(false);
  });

  it('期待回数が分からなければ信頼できるとは言えない', () => {
    expect(isCoverageReliable(checkCoverage(0, 0, WINDOW_SECONDS.day))).toBe(false);
  });
});

describe('formatResponseTime', () => {
  it('1秒未満はミリ秒、1秒以上は秒で表示する', () => {
    expect(formatResponseTime(87)).toBe('87 ms');
    expect(formatResponseTime(999)).toBe('999 ms');
    expect(formatResponseTime(1000)).toBe('1.00 s');
    expect(formatResponseTime(2350)).toBe('2.35 s');
  });

  it('応答が返らなかったチェックはダッシュを返す', () => {
    expect(formatResponseTime(null)).toBe('—');
  });
});
