/**
 * Slack へ送る通知の組み立て。
 *
 * 送信そのもの（fetch）は Worker が行い、ここは本文を作るだけにしてある。
 * 本文の組み立てには「どの情報を、どの順で出すか」という判断が入っていて、
 * それは DB も HTTP も無しでテストできる種類の判断だから。
 *
 * 重複を防ぐ鍵（dedupe key）もここで作る。鍵の作り方そのものが設計判断で、
 * **時刻ではなく incident の ID から作る**。
 * 「前回の実行時刻からの差分」で追う方式は、実行が飛べば取りこぼし、
 * 二度走れば重複する。障害そのものに紐づく鍵なら、いつ何度走っても結果が同じになる。
 */

import { detectionDelaySeconds } from './incident.js';
import { CHECK_ERROR_KIND_LABELS, type CheckErrorKind } from './monitor.js';
import { formatDaysRemaining } from './tls.js';
import { formatDowntime } from './uptime.js';

/** Slack Incoming Webhook に POST する本体。 */
export type SlackMessage = {
  /**
   * 通知センターとモバイルのプッシュに出る文字列。
   * blocks があっても text は必ず入れる。ここを空にすると、
   * 「通知は鳴ったが何の通知か分からない」状態になる。
   */
  text: string;
  blocks: SlackBlock[];
};

type SlackBlock =
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
  | { type: 'section'; fields: { type: 'mrkdwn'; text: string }[] }
  | { type: 'context'; elements: { type: 'mrkdwn'; text: string }[] }
  | { type: 'divider' };

/* -------------------------------------------------------------------------- */
/* 重複を防ぐ鍵                                                                */
/* -------------------------------------------------------------------------- */

export function downDedupeKey(incidentId: string): string {
  return `monitor_down:${incidentId}`;
}

export function recoveredDedupeKey(incidentId: string): string {
  return `monitor_recovered:${incidentId}`;
}

/* -------------------------------------------------------------------------- */
/* 時刻の表記                                                                  */
/* -------------------------------------------------------------------------- */

const JST = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * 通知の時刻は日本時間で書く。
 *
 * Slack はタイムスタンプの自動変換に対応しているが、本文に埋め込んだ時刻は変換されない。
 * DB は UTC なのでそのまま出すと9時間ずれ、受け取った人がログと突き合わせられない。
 */
function formatJst(iso: string): string {
  return `${JST.format(new Date(iso))} JST`;
}

/* -------------------------------------------------------------------------- */
/* ダウン検知                                                                  */
/* -------------------------------------------------------------------------- */

export type DownNotification = {
  monitorName: string;
  url: string;
  cause: CheckErrorKind;
  statusCode: number | null;
  errorMessage: string | null;
  /** 最初に失敗したチェックの時刻（判定が確定した時刻ではない）。 */
  startedAt: string;
  failureCount: number;
  failureThreshold: number;
  intervalSeconds: number;
};

export type NotificationContext = {
  /** ダッシュボードの URL。未設定ならリンクを出さない。 */
  appUrl?: string | undefined;
};

/**
 * ダウンの通知。
 *
 * 出す情報は「受け取った人が次に何をするか」で決めている。
 *   - どのサービスが（名前と URL）
 *   - 何が起きて（原因。タイムアウトと 500 では見る場所が違う）
 *   - いつから（復旧作業の前に、影響時間を把握する）
 *   - どう判定したか（「2回連続で失敗」。1回の瞬断ではないことを示す）
 *
 * 逆に、稼働率や応答時間の履歴は入れない。通知の時点で必要なのは
 * 「今おかしい」ことであって、傾向の分析は画面でやればよい。
 */
export function buildDownMessage(
  info: DownNotification,
  context: NotificationContext = {},
): SlackMessage {
  const cause = CHECK_ERROR_KIND_LABELS[info.cause];
  const causeDetail = info.statusCode === null ? cause : `${cause}（HTTP ${info.statusCode}）`;

  const delaySeconds = detectionDelaySeconds(info.intervalSeconds, info.failureThreshold);
  const judgement =
    info.failureThreshold <= 1
      ? '1回の失敗で異常と判定'
      : `${info.failureThreshold}回連続で失敗（最大 ${formatDowntime(delaySeconds)} の検知遅れ）`;

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:red_circle: *${info.monitorName}* がダウンしています` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*原因*\n${causeDetail}` },
        { type: 'mrkdwn', text: `*開始*\n${formatJst(info.startedAt)}` },
        { type: 'mrkdwn', text: `*URL*\n${info.url}` },
        { type: 'mrkdwn', text: `*判定*\n${judgement}` },
      ],
    },
  ];

  if (info.errorMessage) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `\`${truncate(info.errorMessage, 200)}\`` }],
    });
  }

  if (context.appUrl) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `<${context.appUrl}|StatusPulse で見る>` }],
    });
  }

  return {
    // モバイルのプッシュに出るのはこの行だけ。サービス名と状態を必ず含める。
    text: `[ダウン] ${info.monitorName} — ${causeDetail}`,
    blocks,
  };
}

/* -------------------------------------------------------------------------- */
/* 復旧                                                                        */
/* -------------------------------------------------------------------------- */

export type RecoveredNotification = {
  monitorName: string;
  url: string;
  startedAt: string;
  endedAt: string;
  downtimeSeconds: number;
};

/**
 * 復旧の通知。
 *
 * 復旧を必ず通知するのは、ダウンの通知だけを流すと
 * 「まだ落ちているのか、直ったのか」が Slack を見ても分からないため。
 * 障害対応で最も無駄が出るのは、すでに直っているものを追いかける時間になる。
 *
 * 停止していた時間を入れるのは、それが事後に最も参照される数字だから。
 */
export function buildRecoveredMessage(
  info: RecoveredNotification,
  context: NotificationContext = {},
): SlackMessage {
  const downtime = formatDowntime(info.downtimeSeconds);

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:large_green_circle: *${info.monitorName}* が復旧しました` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*停止していた時間*\n${downtime}` },
        { type: 'mrkdwn', text: `*復旧*\n${formatJst(info.endedAt)}` },
        { type: 'mrkdwn', text: `*開始*\n${formatJst(info.startedAt)}` },
        { type: 'mrkdwn', text: `*URL*\n${info.url}` },
      ],
    },
  ];

  if (context.appUrl) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `<${context.appUrl}|StatusPulse で見る>` }],
    });
  }

  return {
    text: `[復旧] ${info.monitorName} — 停止 ${downtime}`,
    blocks,
  };
}

/* -------------------------------------------------------------------------- */
/* 証明書の期限（Phase 4）                                                     */
/* -------------------------------------------------------------------------- */

export type CertificateNotification = {
  monitorName: string;
  url: string;
  expiresAt: string;
  issuer: string | null;
  /** この通知を出した閾値（30 または 7）。文面の強さを変える。 */
  thresholdDays: number;
};

/**
 * 証明書の期限が近いことの通知。
 *
 * ダウンの通知と文面の強さを変えている。証明書の期限は「まだ落ちていないが、
 * 放っておけば必ず落ちる」という性質のもので、対応の緊急度が違う。
 * 残り7日を切ったら、その違いも消える。
 */
export function buildCertificateMessage(
  info: CertificateNotification,
  context: NotificationContext = {},
): SlackMessage {
  const critical = info.thresholdDays <= 7;
  const remaining = formatDaysRemaining(info.expiresAt);
  const icon = critical ? ':rotating_light:' : ':warning:';
  const heading = critical
    ? `*${info.monitorName}* の証明書がまもなく期限切れです`
    : `*${info.monitorName}* の証明書の期限が近づいています`;

  const blocks: SlackBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `${icon} ${heading}` } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*残り*\n${remaining}` },
        { type: 'mrkdwn', text: `*期限*\n${formatJst(info.expiresAt)}` },
        { type: 'mrkdwn', text: `*URL*\n${info.url}` },
        { type: 'mrkdwn', text: `*発行者*\n${info.issuer ?? '不明'}` },
      ],
    },
  ];

  if (info.issuer?.includes('Let') === true) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '自動更新が動いていれば、この通知が届く前に更新されているはずです。',
        },
      ],
    });
  }

  if (context.appUrl) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `<${context.appUrl}|StatusPulse で見る>` }],
    });
  }

  return {
    text: `[証明書] ${info.monitorName} — ${remaining}で期限切れ`,
    blocks,
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
