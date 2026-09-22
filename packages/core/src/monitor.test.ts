import { describe, expect, it } from 'vitest';

import {
  classifyFetchError,
  isAcceptableStatus,
  isCheckDue,
  nextMonitorState,
  observeFailure,
  observeResponse,
  type MonitorState,
} from './monitor.js';

const NOW = new Date('2026-09-22T12:00:00.000Z');

/** 指定した秒数だけ過去の ISO 文字列。 */
function secondsAgo(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1000).toISOString();
}

describe('isCheckDue', () => {
  it('一度もチェックしていない対象は常に対象になる', () => {
    expect(isCheckDue({ isEnabled: true, intervalSeconds: 3600, lastCheckedAt: null }, NOW)).toBe(
      true,
    );
  });

  it('無効化された対象は、間隔を過ぎていても対象にしない', () => {
    expect(
      isCheckDue({ isEnabled: false, intervalSeconds: 60, lastCheckedAt: secondsAgo(86_400) }, NOW),
    ).toBe(false);
  });

  it('無効化された対象は、一度もチェックしていなくても対象にしない', () => {
    expect(isCheckDue({ isEnabled: false, intervalSeconds: 60, lastCheckedAt: null }, NOW)).toBe(
      false,
    );
  });

  it('間隔を十分過ぎていれば対象になる', () => {
    expect(
      isCheckDue({ isEnabled: true, intervalSeconds: 300, lastCheckedAt: secondsAgo(301) }, NOW),
    ).toBe(true);
  });

  /**
   * 許容幅が無いと、1分間隔の対象が実質2分間隔になる。
   * Cron の起動ゆれで経過が 59.x 秒になった回が飛ばされ、次の起動まで待つため。
   */
  it('許容幅（30秒）の内側なら、間隔に達していなくても対象になる', () => {
    expect(
      isCheckDue({ isEnabled: true, intervalSeconds: 60, lastCheckedAt: secondsAgo(59) }, NOW),
    ).toBe(true);
    expect(
      isCheckDue({ isEnabled: true, intervalSeconds: 60, lastCheckedAt: secondsAgo(30) }, NOW),
    ).toBe(true);
  });

  it('許容幅の外側では対象にならない', () => {
    expect(
      isCheckDue({ isEnabled: true, intervalSeconds: 60, lastCheckedAt: secondsAgo(29) }, NOW),
    ).toBe(false);
    expect(
      isCheckDue({ isEnabled: true, intervalSeconds: 300, lastCheckedAt: secondsAgo(269) }, NOW),
    ).toBe(false);
  });

  it('許容幅は引数で変えられる（0 にすれば厳密な比較になる）', () => {
    const monitor = { isEnabled: true, intervalSeconds: 60, lastCheckedAt: secondsAgo(59) };
    expect(isCheckDue(monitor, NOW, 0)).toBe(false);
    expect(isCheckDue(monitor, NOW, 1)).toBe(true);
  });
});

describe('isAcceptableStatus', () => {
  it('期待値の指定が無ければ 2xx / 3xx を正常とみなす', () => {
    expect(isAcceptableStatus(200, null)).toBe(true);
    expect(isAcceptableStatus(204, null)).toBe(true);
    expect(isAcceptableStatus(301, null)).toBe(true);
    expect(isAcceptableStatus(399, null)).toBe(true);
  });

  it('期待値の指定が無ければ 4xx / 5xx は異常とみなす', () => {
    expect(isAcceptableStatus(400, null)).toBe(false);
    expect(isAcceptableStatus(404, null)).toBe(false);
    expect(isAcceptableStatus(500, null)).toBe(false);
    expect(isAcceptableStatus(503, null)).toBe(false);
  });

  it('境界（199 / 200 / 399 / 400）', () => {
    expect(isAcceptableStatus(199, null)).toBe(false);
    expect(isAcceptableStatus(200, null)).toBe(true);
    expect(isAcceptableStatus(399, null)).toBe(true);
    expect(isAcceptableStatus(400, null)).toBe(false);
  });

  it('期待値を指定したら、その値だけが正常になる', () => {
    expect(isAcceptableStatus(200, 200)).toBe(true);
    expect(isAcceptableStatus(204, 200)).toBe(false);
    // 「301 が返ること自体を確かめたい」場合。既定では 3xx も 200 も正常なので区別できない。
    expect(isAcceptableStatus(301, 301)).toBe(true);
    expect(isAcceptableStatus(200, 301)).toBe(false);
  });
});

describe('observeResponse', () => {
  it('正常なら応答時間を残し、失敗理由は付けない', () => {
    expect(observeResponse(200, 123, null)).toEqual({
      result: 'up',
      statusCode: 200,
      responseTimeMs: 123,
      errorKind: null,
      errorMessage: null,
    });
  });

  /**
   * 「500 を返すが応答は速い」と「応答自体が遅い」は別の障害なので、
   * ステータス異常でも応答時間は捨てない。
   */
  it('ステータス異常でも応答時間は残す', () => {
    const observation = observeResponse(503, 87, null);
    expect(observation.result).toBe('down');
    expect(observation.responseTimeMs).toBe(87);
    expect(observation.errorKind).toBe('status');
  });

  it('期待値を指定していたら、メッセージにその値を含める', () => {
    expect(observeResponse(500, 10, 200).errorMessage).toContain('期待: 200');
    expect(observeResponse(500, 10, null).errorMessage).not.toContain('期待');
  });
});

describe('observeFailure', () => {
  /**
   * 接続できずに費やした時間を応答時間として記録すると、
   * 障害中に平均応答時間が改善したように見えてしまう。
   */
  it('応答が返らなかったチェックは応答時間を持たない', () => {
    const observation = observeFailure('timeout', '10000ms 以内に応答がありませんでした');
    expect(observation.result).toBe('down');
    expect(observation.responseTimeMs).toBeNull();
    expect(observation.statusCode).toBeNull();
    expect(observation.errorKind).toBe('timeout');
  });

  it('長すぎるエラーメッセージは切り詰める', () => {
    expect(observeFailure('unknown', 'x'.repeat(2000)).errorMessage).toHaveLength(500);
  });
});

describe('classifyFetchError', () => {
  it('AbortError / TimeoutError はタイムアウトとして扱う', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(classifyFetchError(abort)).toBe('timeout');

    const timeout = new Error('The operation timed out');
    timeout.name = 'TimeoutError';
    expect(classifyFetchError(timeout)).toBe('timeout');
  });

  /**
   * 実行環境ごとに文言が違うので、実際に見かけた形をすべて拾う。
   * Workers / Node / curl のどれで動かしても同じ分類になることを確かめる。
   */
  it('メッセージから種類を推定する', () => {
    expect(classifyFetchError(new Error('getaddrinfo ENOTFOUND example.com'))).toBe('dns');
    expect(classifyFetchError(new Error('DNS name resolution failed'))).toBe('dns');
    expect(classifyFetchError(new Error('The hostname could not be resolved'))).toBe('dns');
    expect(classifyFetchError(new Error('dial tcp: no such host'))).toBe('dns');

    expect(classifyFetchError(new Error('certificate has expired'))).toBe('tls');
    expect(classifyFetchError(new Error('SSL handshake failed'))).toBe('tls');

    expect(classifyFetchError(new Error('connect ECONNREFUSED'))).toBe('network');
    expect(classifyFetchError(new Error('Network is unreachable'))).toBe('network');
  });

  /** 推定に失敗しても記録そのものは失わない（メッセージは error_message に残る）。 */
  it('分類できないものは unknown に落とす', () => {
    expect(classifyFetchError(new Error('something went sideways'))).toBe('unknown');
    expect(classifyFetchError('文字列が投げられた')).toBe('unknown');
    expect(classifyFetchError(null)).toBe('unknown');
  });
});

describe('nextMonitorState', () => {
  const up: MonitorState = { status: 'up', consecutiveFailures: 0 };
  const down: MonitorState = { status: 'down', consecutiveFailures: 3 };
  const unknown: MonitorState = { status: 'unknown', consecutiveFailures: 0 };

  describe('閾値 1（Phase 1 の既定）', () => {
    it('1回の失敗で down になり、went_down を返す', () => {
      expect(nextMonitorState(up, 'down', 1)).toEqual({
        status: 'down',
        consecutiveFailures: 1,
        event: 'went_down',
      });
    });

    it('down が続いている間は event を返さない（通知が鳴り続けない）', () => {
      expect(nextMonitorState(down, 'down', 1)).toEqual({
        status: 'down',
        consecutiveFailures: 4,
        event: null,
      });
    });

    it('成功したら復旧し、recovered を返す', () => {
      expect(nextMonitorState(down, 'up', 1)).toEqual({
        status: 'up',
        consecutiveFailures: 0,
        event: 'recovered',
      });
    });

    it('正常が続いている間は event を返さない', () => {
      expect(nextMonitorState(up, 'up', 1)).toEqual({
        status: 'up',
        consecutiveFailures: 0,
        event: null,
      });
    });
  });

  describe('未チェック（unknown）からの遷移', () => {
    /** 「まだ確かめていない」と「確かめたら落ちていた」は別の事実。 */
    it('初回が成功なら up になるが、復旧ではないので event は返さない', () => {
      expect(nextMonitorState(unknown, 'up', 1)).toEqual({
        status: 'up',
        consecutiveFailures: 0,
        event: null,
      });
    });

    it('閾値に届けば unknown からでも down になる（最初から壊れている URL）', () => {
      expect(nextMonitorState(unknown, 'down', 1)).toEqual({
        status: 'down',
        consecutiveFailures: 1,
        event: 'went_down',
      });
    });

    it('閾値に届くまでは unknown のまま留まる', () => {
      const afterFirst = nextMonitorState(unknown, 'down', 3);
      expect(afterFirst).toEqual({ status: 'unknown', consecutiveFailures: 1, event: null });

      const afterSecond = nextMonitorState(afterFirst, 'down', 3);
      expect(afterSecond).toEqual({ status: 'unknown', consecutiveFailures: 2, event: null });
    });
  });

  describe('閾値 3（Phase 2 で使う設定）', () => {
    it('3回連続するまで down にならない', () => {
      const first = nextMonitorState(up, 'down', 3);
      expect(first).toEqual({ status: 'up', consecutiveFailures: 1, event: null });

      const second = nextMonitorState(first, 'down', 3);
      expect(second).toEqual({ status: 'up', consecutiveFailures: 2, event: null });

      const third = nextMonitorState(second, 'down', 3);
      expect(third).toEqual({ status: 'down', consecutiveFailures: 3, event: 'went_down' });
    });

    /**
     * 誤検知対策の本体。2回失敗しても、その後成功すればカウントは 0 に戻る。
     * 窓（直近N回中M回）で判定すると、この復帰が遅れる。
     */
    it('途中で成功したら失敗カウントは 0 に戻り、down にならない', () => {
      const first = nextMonitorState(up, 'down', 3);
      const second = nextMonitorState(first, 'down', 3);
      const recovered = nextMonitorState(second, 'up', 3);

      expect(recovered).toEqual({ status: 'up', consecutiveFailures: 0, event: null });

      // カウントが戻っているので、次の失敗はまた 1 から数え直しになる
      expect(nextMonitorState(recovered, 'down', 3).consecutiveFailures).toBe(1);
    });

    it('down からの復旧は1回の成功で足りる（復旧の検知は遅らせない）', () => {
      expect(nextMonitorState({ status: 'down', consecutiveFailures: 9 }, 'up', 3)).toEqual({
        status: 'up',
        consecutiveFailures: 0,
        event: 'recovered',
      });
    });
  });

  it('閾値が 0 以下でも 1 として扱う（設定ミスで永久に down にならない状態を作らない）', () => {
    expect(nextMonitorState(up, 'down', 0).status).toBe('down');
    expect(nextMonitorState(up, 'down', -5).status).toBe('down');
  });
});
