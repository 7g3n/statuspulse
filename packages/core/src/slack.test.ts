import { describe, expect, it } from 'vitest';

import {
  buildDownMessage,
  buildRecoveredMessage,
  downDedupeKey,
  recoveredDedupeKey,
  type DownNotification,
  type RecoveredNotification,
} from './slack.js';

const INCIDENT_ID = '11111111-1111-4111-8111-000000000001';

const DOWN: DownNotification = {
  monitorName: 'StockDesk（本番）',
  url: 'https://stockdesk.example.com/',
  cause: 'status',
  statusCode: 502,
  errorMessage: 'HTTP 502 が返りました',
  startedAt: '2026-09-22T00:05:00.000Z',
  failureCount: 2,
  failureThreshold: 2,
  intervalSeconds: 300,
};

const RECOVERED: RecoveredNotification = {
  monitorName: 'StockDesk（本番）',
  url: 'https://stockdesk.example.com/',
  startedAt: '2026-09-22T00:05:00.000Z',
  endedAt: '2026-09-22T00:45:00.000Z',
  downtimeSeconds: 2400,
};

function allText(message: { blocks: unknown[] }): string {
  return JSON.stringify(message.blocks);
}

describe('重複を防ぐ鍵', () => {
  /**
   * 鍵を incident の ID から作るのが要点。
   * 時刻で追う方式は、実行が飛べば取りこぼし、二度走れば重複する。
   */
  it('同じ障害からは必ず同じ鍵が出る', () => {
    expect(downDedupeKey(INCIDENT_ID)).toBe(downDedupeKey(INCIDENT_ID));
    expect(recoveredDedupeKey(INCIDENT_ID)).toBe(recoveredDedupeKey(INCIDENT_ID));
  });

  it('ダウンと復旧は別の鍵になる（同じ障害でも2通送れる）', () => {
    expect(downDedupeKey(INCIDENT_ID)).not.toBe(recoveredDedupeKey(INCIDENT_ID));
  });

  it('障害が違えば鍵も違う', () => {
    expect(downDedupeKey(INCIDENT_ID)).not.toBe(
      downDedupeKey('22222222-2222-4222-8222-000000000002'),
    );
  });
});

describe('buildDownMessage', () => {
  /**
   * text はモバイルのプッシュに出る唯一の行。
   * ここが空だと「通知は鳴ったが何の通知か分からない」状態になる。
   */
  it('text だけでサービス名と状態が分かる', () => {
    const message = buildDownMessage(DOWN);
    expect(message.text).toContain('ダウン');
    expect(message.text).toContain('StockDesk（本番）');
    expect(message.text).toContain('ステータス異常');
  });

  it('原因・開始時刻・URL・判定方法を本文に含める', () => {
    const body = allText(buildDownMessage(DOWN));
    expect(body).toContain('HTTP 502');
    expect(body).toContain('https://stockdesk.example.com/');
    expect(body).toContain('2回連続で失敗');
  });

  /** DB は UTC。そのまま出すと9時間ずれ、受け取った人がログと突き合わせられない。 */
  it('時刻を日本時間で書く', () => {
    const body = allText(buildDownMessage(DOWN));
    expect(body).toContain('JST');
    // 00:05 UTC = 09:05 JST
    expect(body).toContain('09:05');
  });

  it('閾値が 1 のときは「連続」とは書かない', () => {
    const body = allText(buildDownMessage({ ...DOWN, failureThreshold: 1, failureCount: 1 }));
    expect(body).toContain('1回の失敗で異常と判定');
    expect(body).not.toContain('連続');
  });

  /** 閾値を上げると検知が遅れる。受け取った人が影響時間を見積もれるよう明記する。 */
  it('閾値が 2 以上なら検知遅れの最大値を添える', () => {
    const body = allText(buildDownMessage({ ...DOWN, failureThreshold: 3, intervalSeconds: 3600 }));
    expect(body).toContain('2時間');
  });

  it('アプリの URL が渡されたときだけリンクを出す', () => {
    expect(allText(buildDownMessage(DOWN))).not.toContain('StatusPulse で見る');
    expect(allText(buildDownMessage(DOWN, { appUrl: 'https://status.example.com' }))).toContain(
      'StatusPulse で見る',
    );
  });

  it('長すぎるエラーメッセージは切り詰める', () => {
    const body = allText(buildDownMessage({ ...DOWN, errorMessage: 'x'.repeat(1000) }));
    expect(body).toContain('…');
    expect(body.length).toBeLessThan(1500);
  });

  it('エラーメッセージが無ければその欄を出さない', () => {
    const message = buildDownMessage({ ...DOWN, errorMessage: null });
    expect(message.blocks.some((block) => 'elements' in block)).toBe(false);
  });
});

describe('buildRecoveredMessage', () => {
  /**
   * 復旧を必ず通知するのは、ダウンだけ流すと
   * 「まだ落ちているのか、直ったのか」が Slack を見ても分からないため。
   */
  it('text だけで復旧と停止時間が分かる', () => {
    const message = buildRecoveredMessage(RECOVERED);
    expect(message.text).toContain('復旧');
    expect(message.text).toContain('StockDesk（本番）');
    expect(message.text).toContain('40分');
  });

  it('開始と復旧の時刻を日本時間で併記する', () => {
    const body = allText(buildRecoveredMessage(RECOVERED));
    expect(body).toContain('09:05');
    expect(body).toContain('09:45');
  });

  it('停止時間が 1分未満でも「なし」にはしない表記になる', () => {
    expect(buildRecoveredMessage({ ...RECOVERED, downtimeSeconds: 30 }).text).toContain('30秒');
  });
});
