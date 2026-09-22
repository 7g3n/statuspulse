/**
 * 監視対象の判定ロジック。
 *
 * このモジュールは「観測」と「判定」を分けることを中心に組み立てている。
 *
 *   観測 = checks.result           — 1回のリクエストが成功したか（事実）
 *   判定 = monitors.current_status — その監視対象を今どう扱うか（解釈）
 *
 * 1回のタイムアウトで即「ダウン」と言い切るのは誤検知の元だが、
 * かといって観測の側を書き換えて「なかったこと」にしてはならない。
 * 事実は checks に全件残し、そこから状態を導く規則だけをここに置く。
 *
 * Phase 1 では failureThreshold = 1（1回の失敗で down）。
 * Phase 2 で N 回連続を導入するが、変わるのは閾値の値だけで、この関数は変わらない。
 *
 * ここにあるのはすべて純粋関数で、DB も Worker も起動せずに検証できる。
 * 画面（web）と定期処理（cron）が同じ関数を使うので、
 * 「ダッシュボードは正常なのに通知は異常」というずれが起きない。
 */

/** 監視対象の現在の状態。DB の monitor_status enum と一致させる。 */
export const MONITOR_STATUSES = ['unknown', 'up', 'down'] as const;
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];

export const MONITOR_STATUS_LABELS: Record<MonitorStatus, string> = {
  unknown: '未チェック',
  up: '正常',
  down: '異常',
};

/** 1回のチェックの観測結果。DB の check_result enum と一致させる。 */
export const CHECK_RESULTS = ['up', 'down'] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

/**
 * 失敗の種類。DB の check_error_kind enum と一致させる。
 *
 * 「落ちている」と一口に言っても、名前が引けないのとステータスが 500 なのとでは
 * 打つ手がまったく違う。原因を後から集計できるよう、自由記述の error_message とは別に、
 * 分類可能な enum を必ず持たせる。
 */
export const CHECK_ERROR_KINDS = [
  'timeout', // 制限時間内に応答がなかった
  'dns', // 名前解決に失敗した
  'tls', // 証明書の検証に失敗した
  'network', // 接続そのものが確立できなかった
  'status', // 応答は返ったが、期待するステータスコードではなかった
  'body', // ステータスは正常だが、本文に期待する文字列が無かった（Phase 4）
  'unknown', // 上記に分類できなかった
] as const;
export type CheckErrorKind = (typeof CHECK_ERROR_KINDS)[number];

export const CHECK_ERROR_KIND_LABELS: Record<CheckErrorKind, string> = {
  timeout: 'タイムアウト',
  dns: '名前解決の失敗',
  tls: '証明書エラー',
  network: '接続エラー',
  status: 'ステータス異常',
  body: '本文が期待と違う',
  unknown: '不明なエラー',
};

/** HTTP メソッド。DB の http_method enum と一致させる。 */
export const HTTP_METHODS = ['GET', 'HEAD'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * 選べるチェック間隔。
 *
 * 自由入力にしない理由は2つある。
 *
 *   1. Cron Triggers は1分ごとにしか起動しない。それより短い間隔は構造上実現できず、
 *      入力できてしまうと「設定したのに守られない」状態になる。
 *   2. 監視対象から見れば、チェックは外部から来るトラフィックそのもの。
 *      10 秒間隔のような値を許すと、監視が相手の負荷になる。
 *
 * 短い間隔ほど検知は速いが、そのぶん相手への負荷と保存する行数が増える。
 * 60 秒を下限、1 時間を上限として、その間を選択肢にしている。
 */
export const CHECK_INTERVALS = [60, 300, 900, 1800, 3600] as const;
export type CheckInterval = (typeof CHECK_INTERVALS)[number];

export const CHECK_INTERVAL_LABELS: Record<CheckInterval, string> = {
  60: '1分',
  300: '5分',
  900: '15分',
  1800: '30分',
  3600: '1時間',
};

export function isCheckInterval(value: number): value is CheckInterval {
  return (CHECK_INTERVALS as readonly number[]).includes(value);
}

/** タイムアウトの既定値と範囲。上限は Worker の実行時間より十分短く取る。 */
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 30_000;

/* -------------------------------------------------------------------------- */
/* 次にチェックすべきか                                                        */
/* -------------------------------------------------------------------------- */

/** Cron の起動間隔（秒）。wrangler.toml の crons 設定に対応する。 */
export const CRON_PERIOD_SECONDS = 60;

/**
 * due 判定の許容幅（秒）。
 *
 * Cron は毎分ほぼ同じ秒に起動するが、起動時刻には数秒のぶれがある。
 * 「前回から interval 秒以上経過したか」を厳密に見ると、1分間隔の対象で
 * 経過が 59.4 秒になった回が飛ばされ、次の起動まで待って実質 2 分間隔になる。
 * これが毎回起きると、1分間隔の監視が2分間隔として動いてしまう。
 *
 * そこで判定を半周期ぶん早める。ごく稀に間隔がわずかに詰まるが、
 * 「設定した間隔より粗くなる」方が監視ツールとしては明確に悪い。
 */
export const DUE_TOLERANCE_SECONDS = CRON_PERIOD_SECONDS / 2;

export type DueCandidate = {
  isEnabled: boolean;
  intervalSeconds: number;
  /** ISO 8601。一度もチェックしていなければ null。 */
  lastCheckedAt: string | null;
};

/**
 * 今このタイミングでチェックすべきか。
 *
 * 一度もチェックしていない対象は常に対象になる（登録直後に結果が出てほしいため）。
 * 無効にした対象は対象にしない。
 */
export function isCheckDue(
  monitor: DueCandidate,
  now: Date,
  toleranceSeconds: number = DUE_TOLERANCE_SECONDS,
): boolean {
  if (!monitor.isEnabled) return false;
  if (monitor.lastCheckedAt === null) return true;

  const elapsedSeconds = (now.getTime() - new Date(monitor.lastCheckedAt).getTime()) / 1000;
  return elapsedSeconds >= monitor.intervalSeconds - toleranceSeconds;
}

/* -------------------------------------------------------------------------- */
/* 1回のチェック結果の評価                                                     */
/* -------------------------------------------------------------------------- */

/**
 * ステータスコードが正常か。
 *
 * expectedStatusCode の指定があればその値との一致、なければ 2xx / 3xx を正常とみなす。
 *
 * 3xx を既定で正常に含めるのは、リダイレクトを追った結果として 3xx が残るのは
 * 追跡の上限に達した場合などに限られ、「サイトは生きている」ことに変わりはないため。
 * 逆に「301 が返ること自体を確かめたい」場合は expectedStatusCode = 301 と明示できる。
 */
export function isAcceptableStatus(statusCode: number, expectedStatusCode: number | null): boolean {
  if (expectedStatusCode !== null) return statusCode === expectedStatusCode;
  return statusCode >= 200 && statusCode < 400;
}

/** checks テーブルに書き込む1行ぶんの観測結果。 */
export type CheckObservation = {
  result: CheckResult;
  statusCode: number | null;
  responseTimeMs: number | null;
  errorKind: CheckErrorKind | null;
  errorMessage: string | null;
};

/**
 * レスポンス本文に、期待する文字列が含まれているか（Phase 4）。
 *
 * 正規表現ではなく「含まれているか」だけにしている。
 * 正規表現は書き手が意図しない量の計算を招きうる（Worker の実行時間を食う）うえ、
 * 監視の設定としては「この文字列が消えたら異常」で足りることがほとんど。
 */
export function matchesExpectedBody(body: string, expected: string | null): boolean {
  if (expected === null || expected === '') return true;
  return body.includes(expected);
}

/** 本文チェックのために読む上限。これを超えるぶんは切り捨てて判定する。 */
export const MAX_BODY_BYTES = 512 * 1024;

export type BodyExpectation = {
  /** 読み取った本文（上限まで）。 */
  text: string;
  /** 期待する文字列。null なら本文を判定しない。 */
  expected: string | null;
};

/**
 * 応答が返ってきた場合の観測結果を組み立てる。
 *
 * ステータスが期待どおりでなくても responseTimeMs は残す。
 * 「500 を返しているが応答は速い」と「応答自体が遅い」は別の障害で、
 * 後から切り分けるには両方の記録が要る。
 *
 * 本文チェック（Phase 4）はステータスの判定を通ったあとに行う。
 * 500 が返っているときに「本文が違う」と報告しても、原因の手がかりにならない。
 * 先に起きている異常の方を理由として残す。
 */
export function observeResponse(
  statusCode: number,
  responseTimeMs: number,
  expectedStatusCode: number | null,
  body?: BodyExpectation,
): CheckObservation {
  if (!isAcceptableStatus(statusCode, expectedStatusCode)) {
    return {
      result: 'down',
      statusCode,
      responseTimeMs,
      errorKind: 'status',
      errorMessage:
        expectedStatusCode === null
          ? 'HTTP ' + statusCode + ' が返りました'
          : 'HTTP ' + statusCode + ' が返りました（期待: ' + expectedStatusCode + '）',
    };
  }

  if (body && !matchesExpectedBody(body.text, body.expected)) {
    return {
      result: 'down',
      statusCode,
      responseTimeMs,
      errorKind: 'body',
      errorMessage: '本文に「' + body.expected + '」が含まれていません',
    };
  }

  return { result: 'up', statusCode, responseTimeMs, errorKind: null, errorMessage: null };
}

/**
 * 応答が返らなかった場合の観測結果を組み立てる。
 *
 * responseTimeMs は null にする。接続できずに費やした時間を「応答時間」として
 * 平均に混ぜると、障害中に応答が速くなったように見えてしまう。
 */
export function observeFailure(kind: CheckErrorKind, message: string): CheckObservation {
  return {
    result: 'down',
    statusCode: null,
    responseTimeMs: null,
    errorKind: kind,
    errorMessage: message.slice(0, 500),
  };
}

/**
 * fetch が投げた例外を分類する。
 *
 * Workers の fetch は失敗の理由を型で区別してくれないので、メッセージから推定するほかない。
 * 推定できなければ 'unknown' に落とし、元のメッセージを error_message に残して後から追えるようにする。
 * 分類を誤っても記録そのものは失わない、という順序にしてある。
 */
export function classifyFetchError(error: unknown): CheckErrorKind {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'timeout';
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes('timed out') || lower.includes('timeout')) return 'timeout';

  // 名前解決。Workers / Node / curl で文言が違うので、実際に見かけた形をすべて拾う。
  if (
    lower.includes('getaddrinfo') ||
    lower.includes('enotfound') ||
    lower.includes('dns') ||
    lower.includes('name resolution') ||
    lower.includes('could not be resolved') ||
    lower.includes('no such host')
  ) {
    return 'dns';
  }

  if (
    lower.includes('certificate') ||
    lower.includes('ssl') ||
    lower.includes('tls') ||
    lower.includes('handshake')
  ) {
    return 'tls';
  }

  if (
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('connection') ||
    lower.includes('network') ||
    lower.includes('socket') ||
    lower.includes('unreachable')
  ) {
    return 'network';
  }

  return 'unknown';
}

/* -------------------------------------------------------------------------- */
/* 監視対象の状態遷移                                                          */
/* -------------------------------------------------------------------------- */

export type MonitorState = {
  status: MonitorStatus;
  consecutiveFailures: number;
};

/**
 * 状態が変わった瞬間に起きる出来事。
 *
 * Phase 2 でダウンタイム履歴の記録と Slack 通知の起点になる。
 * Phase 1 では表示に使わないが、「前回の状態と比べる」判断は状態遷移そのものと
 * 同じ場所で決まる。呼び出し側に二重に書かせないために、ここで一緒に返す。
 */
export type MonitorEvent = 'went_down' | 'recovered';

export type MonitorTransition = MonitorState & {
  event: MonitorEvent | null;
};

/**
 * 観測1件を受けて、監視対象の次の状態を決める。
 *
 * 成功したら失敗カウントは即座に 0 に戻す。
 * 「直近5回中3回失敗」のような窓での判定を採らないのは、復旧の検知が遅れるため。
 * 落ちたことに気付くのが遅いのと、直ったことに気付くのが遅いのとでは、
 * 後者の方が「まだ落ちている」という誤った表示を長く残す。
 *
 * 失敗が閾値に届くまでは status を変えない（＝直前の状態を維持する）。
 * 登録直後でまだ一度も結果が出ていない対象は、閾値に届くまで unknown のまま留まる。
 * 「まだ確かめていない」ことと「確かめたら落ちていた」ことは別の事実なので、
 * 判定が確定するまでは unknown を down で上書きしない。
 * 閾値に届けば unknown からでも down になる（登録した URL が最初から壊れている場合）。
 */
export function nextMonitorState(
  current: MonitorState,
  result: CheckResult,
  failureThreshold: number,
): MonitorTransition {
  const threshold = Math.max(1, failureThreshold);

  if (result === 'up') {
    return {
      status: 'up',
      consecutiveFailures: 0,
      event: current.status === 'down' ? 'recovered' : null,
    };
  }

  const consecutiveFailures = current.consecutiveFailures + 1;
  const status: MonitorStatus = consecutiveFailures >= threshold ? 'down' : current.status;

  return {
    status,
    consecutiveFailures,
    event: status === 'down' && current.status !== 'down' ? 'went_down' : null,
  };
}
