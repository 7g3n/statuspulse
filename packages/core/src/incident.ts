/**
 * ダウンタイム（インシデント）の扱い。
 *
 * incidents は checks から導かれる集約だが、都度計算せずテーブルとして持っている。
 * 理由は3つあり、いずれも「安定した ID が要る」ことに帰着する。
 *
 *   - 通知の重複判定に「この障害」を一意に指す鍵が要る
 *   - 保持期間を過ぎて checks が消えても、障害の記録は残したい
 *   - Phase 4 のポストマーテムをぶら下げる先になる
 *
 * ここにある関数は表示と判定の補助で、開閉そのものは record_check()（DB）が行う。
 */

import { CHECK_ERROR_KIND_LABELS, type CheckErrorKind } from './monitor.js';

export type IncidentPeriod = {
  startedAt: string;
  /** null は継続中。 */
  endedAt: string | null;
};

export function isOngoing(incident: IncidentPeriod): boolean {
  return incident.endedAt === null;
}

/**
 * 継続時間（秒）。継続中なら「今まで」で数える。
 *
 * DB のビューも同じ計算をしているが、こちらは画面が1秒ごとに描き直すときや
 * モックで使う。定義を1か所に書いておき、両者がずれていないことをテストで押さえる。
 */
export function incidentDurationSeconds(
  incident: IncidentPeriod,
  now: number = Date.now(),
): number {
  const end = incident.endedAt === null ? now : Date.parse(incident.endedAt);
  return Math.max(0, (end - Date.parse(incident.startedAt)) / 1000);
}

/**
 * 期間と重なっている秒数。
 *
 * 集計期間をまたぐ障害は、はみ出したぶんを切り詰めて数える。
 * 「7日前に始まって今も続いている障害」を全期間ぶん数えると、
 * 7日間の稼働率が 0% になってしまう。
 */
export function overlapSeconds(
  incident: IncidentPeriod,
  windowStart: number,
  windowEnd: number,
): number {
  const start = Math.max(Date.parse(incident.startedAt), windowStart);
  const end = Math.min(
    incident.endedAt === null ? windowEnd : Date.parse(incident.endedAt),
    windowEnd,
  );
  return Math.max(0, (end - start) / 1000);
}

/** 複数の障害が期間内で占める合計秒数。重なりは想定しない（1対象に継続中は1本だけ）。 */
export function totalDowntimeSeconds(
  incidents: readonly IncidentPeriod[],
  windowStart: number,
  windowEnd: number,
): number {
  return incidents.reduce(
    (total, incident) => total + overlapSeconds(incident, windowStart, windowEnd),
    0,
  );
}

/* -------------------------------------------------------------------------- */
/* 検知の遅れ                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 閾値を N にしたときに、ダウンと判定するまでにかかる最大の時間（秒）。
 *
 * 閾値は誤検知を減らすが、そのぶん検知が遅れる。遅れは「間隔 × (N − 1)」で、
 * 1時間間隔の対象を 3 にすると最大2時間気付けない。
 *
 * この値を設定画面に出すのは、閾値が「大きいほど安全な設定」ではないことを
 * 選ぶ時点で見せるため。トレードオフを数字にしないと、利用者は選べない。
 */
export function detectionDelaySeconds(intervalSeconds: number, failureThreshold: number): number {
  return intervalSeconds * Math.max(0, Math.max(1, failureThreshold) - 1);
}

/* -------------------------------------------------------------------------- */
/* 表示                                                                        */
/* -------------------------------------------------------------------------- */

/** 障害の原因を1行で言い表す。cause だけでは伝わらない場合にステータスを添える。 */
export function describeCause(cause: CheckErrorKind, statusCode: number | null): string {
  const label = CHECK_ERROR_KIND_LABELS[cause];
  return statusCode === null ? label : `${label}（HTTP ${statusCode}）`;
}
