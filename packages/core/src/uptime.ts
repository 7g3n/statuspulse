/**
 * 稼働率の計算と表示。
 *
 * 定義は2つあり、役割が違う。
 *
 *   時間ベース（Phase 2 以降の主）  = 1 − 停止していた時間 ÷ 対象期間
 *   チェック回数ベース（Phase 1）    = 成功したチェック回数 ÷ 実行したチェック回数
 *
 * Phase 1 は incidents（ダウンの期間）を持っていなかったので回数ベースしか出せなかった。
 * 期間を持った今は時間ベースが主で、回数は「その数字がどれだけの観測に支えられているか」
 * を示す補助として残してある。
 *
 * どちらの定義でも残る弱点が1つある。**どちらも「監視できていた時間」の話でしかない。**
 * Worker 自体が止まっていれば、その間の障害はそもそも観測されず、
 * incidents にも checks にも現れない。稼働率は実態より良く出る。
 *
 * 黙って良い数字を出すのは監視ツールとして最も避けたい挙動なので、
 * 期待されるチェック回数と実際の回数を突き合わせる checkCoverage() を用意し、
 * 取りこぼしがあることを画面に出す。詳細は docs/decisions.md。
 */

/* -------------------------------------------------------------------------- */
/* 時間ベースの稼働率（Phase 2）                                               */
/* -------------------------------------------------------------------------- */

/**
 * 停止していた時間から稼働率を出す。
 *
 * Phase 2 でダウンタイムの期間（incidents）を持ったので、こちらが主になった。
 * 「99.5%」が意味するのが「チェックの 0.5% が失敗した」ではなく
 * 「期間の 0.5% だけ止まっていた」になり、他のサービスが出す稼働率と比較できる。
 *
 * windowSeconds は observedWindowSeconds() で監視対象の年齢に切り詰めてから渡す。
 * 登録して1時間の対象を24時間で割ると、稼働率が常に 95% 台に見える。
 */
export function timeBasedUptime(downSeconds: number, windowSeconds: number): number | null {
  if (windowSeconds <= 0) return null;
  // 継続中の障害や時刻のずれで、停止時間が期間を超えることがある。負の稼働率は出さない。
  const clamped = Math.min(Math.max(downSeconds, 0), windowSeconds);
  return 1 - clamped / windowSeconds;
}

/**
 * 集計期間を、その監視対象が存在していた時間まで切り詰める。
 *
 * 「24時間の稼働率」は、24時間ぶん監視していて初めて言える。
 * 足りないぶんを稼働扱いにしても停止扱いにしても、どちらも実態ではない。
 */
export function observedWindowSeconds(
  createdAt: string,
  windowSeconds: number,
  now: number = Date.now(),
): number {
  const ageSeconds = (now - Date.parse(createdAt)) / 1000;
  return Math.max(0, Math.min(windowSeconds, ageSeconds));
}

/** 停止時間の表示。0 は「なし」と書く（「0分」は計測できていないようにも読める）。 */
export function formatDowntime(seconds: number): string {
  if (seconds <= 0) return 'なし';
  if (seconds < 60) return `${Math.round(seconds)}秒`;

  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}分`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes === 0 ? `${hours}時間` : `${hours}時間${minutes}分`;

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}日` : `${days}日${restHours}時間`;
}

/* -------------------------------------------------------------------------- */
/* チェック回数ベースの稼働率                                                  */
/* -------------------------------------------------------------------------- */

/** ある期間のチェック結果の集計。DB のビューが返す形。 */
export type UptimeCounts = {
  /** 実行したチェック回数 */
  total: number;
  /** そのうち成功した回数 */
  up: number;
};

/**
 * 稼働率を 0–1 で返す。チェックが1回もなければ null。
 *
 * 0 ではなく null を返すのは、「0% 稼働」と「まだデータがない」がまったく違う話だから。
 * 登録直後の監視対象を 0% と表示すると、落ちているように見える。
 */
export function uptimeRatio(counts: UptimeCounts): number | null {
  if (counts.total <= 0) return null;
  return counts.up / counts.total;
}

/**
 * 稼働率をパーセント表記の文字列にする。
 *
 * **切り上げず、必ず切り捨てる。** 10000 回中 1 回落ちていれば 99.99% だが、
 * 小数第1位で四捨五入すると 100.0% になる。落ちた事実があるのに 100% と出る表示は、
 * 稼働率という数字の信頼そのものを損なう。
 * 100% と表示してよいのは、失敗が1回もなかったときだけにする。
 */
export function formatUptimePercent(ratio: number | null, fractionDigits = 2): string {
  if (ratio === null) return '—';
  if (ratio >= 1) return '100' + (fractionDigits > 0 ? '.' + '0'.repeat(fractionDigits) : '');

  const scale = Math.pow(10, fractionDigits);
  const truncated = Math.floor(ratio * 100 * scale) / scale;
  return truncated.toFixed(fractionDigits);
}

/**
 * 稼働率の評価。色分けの根拠をここ1か所に集める。
 *
 * 境界は「月あたりどれだけ落ちてよいか」から決めている。
 *   99.9% — 月あたり約 43 分。個人サービスの実用上の目標値
 *   99.0% — 月あたり約 7.2 時間。放置はできないが致命的でもない
 *   それ未満 — 明らかに手を入れるべき状態
 */
export type UptimeGrade = 'healthy' | 'degraded' | 'critical' | 'unknown';

export const UPTIME_GRADE_THRESHOLDS = {
  healthy: 0.999,
  degraded: 0.99,
} as const;

export function gradeUptime(ratio: number | null): UptimeGrade {
  if (ratio === null) return 'unknown';
  if (ratio >= UPTIME_GRADE_THRESHOLDS.healthy) return 'healthy';
  if (ratio >= UPTIME_GRADE_THRESHOLDS.degraded) return 'degraded';
  return 'critical';
}

/* -------------------------------------------------------------------------- */
/* 取りこぼしの検出                                                            */
/* -------------------------------------------------------------------------- */

/** 期間中に本来実行されるはずのチェック回数。 */
export function expectedCheckCount(intervalSeconds: number, windowSeconds: number): number {
  if (intervalSeconds <= 0) return 0;
  return Math.floor(windowSeconds / intervalSeconds);
}

export type Coverage = {
  expected: number;
  actual: number;
  /** 実測 ÷ 期待。期待が 0 なら null。1 を超える場合は 1 に丸める。 */
  ratio: number | null;
};

/**
 * 「本来あるべき回数」に対して何回チェックできたか。
 *
 * 監視対象を登録した直後は期間の全体ぶんのデータが無いので、必ず低い値が出る。
 * 呼び出し側は監視対象の作成時刻を考慮して期間を切る必要がある。
 *
 * ratio を 1 で頭打ちにするのは、due 判定の許容幅（DUE_TOLERANCE_SECONDS）により
 * 期待回数をわずかに上回ることがあるため。105% と表示しても意味がない。
 */
export function checkCoverage(
  actual: number,
  intervalSeconds: number,
  windowSeconds: number,
): Coverage {
  const expected = expectedCheckCount(intervalSeconds, windowSeconds);
  if (expected <= 0) return { expected, actual, ratio: null };
  return { expected, actual, ratio: Math.min(1, actual / expected) };
}

/**
 * 稼働率をそのまま信じてよいか。
 *
 * 期待の 9 割を下回ったら、分母が欠けている可能性が高いと見なして画面で注意を促す。
 * 9 割という値は、Cron の起動ゆらぎや一時的なデプロイでは届かず、
 * 「数十分ぶん実行されていない」ときに初めて下回る水準として選んだ。
 */
export const RELIABLE_COVERAGE_RATIO = 0.9;

export function isCoverageReliable(coverage: Coverage): boolean {
  if (coverage.ratio === null) return false;
  return coverage.ratio >= RELIABLE_COVERAGE_RATIO;
}

/* -------------------------------------------------------------------------- */
/* 表示の補助                                                                  */
/* -------------------------------------------------------------------------- */

/** 応答時間。監視ツールでは 1ms 単位の精度に意味がないので整数ミリ秒で丸める。 */
export function formatResponseTime(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return Math.round(ms) + ' ms';
  return (ms / 1000).toFixed(2) + ' s';
}

export const WINDOW_SECONDS = {
  day: 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
} as const;
