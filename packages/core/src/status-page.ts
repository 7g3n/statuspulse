/**
 * 公開ステータスページ（Phase 3）。
 *
 * このページは**認証されていない人**が見る。設計の中心は
 * 「何を出すか」ではなく **「何を出さないか」** にある。
 *
 * public_status()（DB 側）が返さないもの:
 *   - 監視先の URL         … 秘密のパスやクエリを含みうる
 *   - error_message        … スタックトレースや内部ホスト名が入りうる
 *   - status_code          … 利用者の行動を変えないが、内部構成の手がかりになる
 *   - 監視対象の内部名     … 公開用のタイトルを別に持つ
 *   - 所有者・メンバー情報 … 誰が運用しているかは公開情報ではない
 *
 * ここにある型は、その「出してよいものだけ」の形をそのまま写したもの。
 * 型の側でも余計な項目を持たないことで、うっかり画面に出す経路を作らない。
 */

import type { CheckErrorKind, CheckResult, MonitorStatus } from './monitor.js';

export type PublicStatusCheck = {
  checked_at: string;
  result: CheckResult;
  response_time_ms: number | null;
};

export type PublicStatusIncident = {
  started_at: string;
  ended_at: string | null;
  cause: CheckErrorKind;
  duration_seconds: number;
  /**
   * 公開が許可されたポストモーテム（Phase 4）。
   *
   * 許可されていなければキーごと存在しない。`null` を返すのではなく
   * 「無い」状態にしてあるのは、社内向けのメモが空文字として漏れる経路を作らないため。
   */
  postmortem?: string | null;
};

export type PublicStatusWindow = {
  /** 集計した期間（秒）。監視対象の年齢で頭打ちにしてある。 */
  window_seconds: number;
  down_seconds: number;
};

export type PublicStatus = {
  title: string;
  description: string;
  status: MonitorStatus;
  status_changed_at: string | null;
  interval_seconds: number;
  last_checked_at: string | null;
  /** この応答を作った時刻。「いつ時点の情報か」を画面に出すために使う。 */
  generated_at: string;
  uptime: { day: PublicStatusWindow; week: PublicStatusWindow };
  /** 古い順。帯を左から右へ時系列で描くため。 */
  checks: PublicStatusCheck[];
  /** 新しい順。 */
  incidents: PublicStatusIncident[];
};

/* -------------------------------------------------------------------------- */
/* URL                                                                         */
/* -------------------------------------------------------------------------- */

export function statusPagePath(slug: string): string {
  return `/status/${slug}`;
}

export function statusPageUrl(origin: string, slug: string): string {
  return `${origin.replace(/\/$/, '')}${statusPagePath(slug)}`;
}

/* -------------------------------------------------------------------------- */
/* 表示                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 最終チェックが古すぎないか。
 *
 * 公開ページで最も避けたいのは、**定期処理が止まっているのに「正常」と出し続けること**。
 * 見に来た人はその表示を信じて、それ以上確かめない。
 *
 * 間隔の3倍を超えて更新が無ければ、正常とは言い切らずに「確認中」に落とす。
 * 3倍にしているのは、1回の取りこぼしや Cron のゆらぎで「確認中」が出ないようにするため。
 */
export const STALE_CHECK_INTERVAL_FACTOR = 3;

export function isStatusStale(status: PublicStatus, now: number = Date.now()): boolean {
  if (status.last_checked_at === null) return true;
  const elapsedSeconds = (now - Date.parse(status.last_checked_at)) / 1000;
  return elapsedSeconds > status.interval_seconds * STALE_CHECK_INTERVAL_FACTOR;
}

/** 公開ページの見出しに出す状態。内部の3値より粗く、来訪者の関心に合わせる。 */
export type PublicState = 'operational' | 'outage' | 'unknown';

export function publicState(status: PublicStatus, now: number = Date.now()): PublicState {
  if (isStatusStale(status, now)) return 'unknown';
  if (status.status === 'down') return 'outage';
  if (status.status === 'up') return 'operational';
  return 'unknown';
}

export const PUBLIC_STATE_HEADLINES: Record<PublicState, string> = {
  operational: '正常に稼働しています',
  outage: '障害が発生しています',
  unknown: '状態を確認しています',
};

export const PUBLIC_STATE_DESCRIPTIONS: Record<PublicState, string> = {
  operational: '外部からの定期的な確認で、正常な応答が返っています。',
  outage:
    '外部からの確認で、正常な応答が返っていません。復旧作業の状況はこのページで更新されます。',
  unknown: '最新の確認結果が取得できていません。表示されている内容は最新でない可能性があります。',
};
