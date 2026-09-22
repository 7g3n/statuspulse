/**
 * 定期処理（Cloudflare Workers + Cron Triggers）。
 *
 * 毎分起動し、その時点でチェックすべき監視対象だけを調べて結果を記録する。
 *
 * なぜ Worker なのか:
 *   ブラウザを開いている間しか動かない仕組みでは、そもそも監視にならない。
 *   常駐サーバーを持たない構成なので、定期実行だけを Cloudflare の Cron Triggers に任せる。
 *   世界中のエッジから実行されるため、監視元が1か所に固定されない利点もある。
 *
 * 判定ロジックは @statuspulse/core にある。画面と同じ関数を使うので、
 * 「ダッシュボードは正常なのに通知は異常」というずれが起きない。
 *
 * この Worker が担うのは「実行」だけで、「判定」は持たない:
 *   - 誰をチェックするか  → DB の due_monitors()（規則は core の isCheckDue() と対）
 *   - 結果をどう解釈するか → core の observeResponse() / classifyFetchError()
 *   - 状態をどう動かすか   → DB の record_check()（規則は core の nextMonitorState() と対）
 */
import type { Database, DueMonitorRow, RecordCheckResult } from '@statuspulse/core';
import {
  buildCertificateMessage,
  buildClientHello,
  buildDownMessage,
  buildRecoveredMessage,
  certificateAlertThreshold,
  certificateDedupeKey,
  classifyFetchError,
  downDedupeKey,
  extractCertificateDer,
  incidentDurationSeconds,
  MAX_BODY_BYTES,
  observeFailure,
  observeResponse,
  parseCertificate,
  recoveredDedupeKey,
  type CheckObservation,
  type SlackMessage,
} from '@statuspulse/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { connect } from 'cloudflare:sockets';

export type Env = {
  SUPABASE_URL: string;
  /** service_role キー。`wrangler secret put SUPABASE_SERVICE_ROLE_KEY` で登録する。 */
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Slack の Incoming Webhook。未設定ならログ出力のみになる。 */
  SLACK_WEBHOOK_URL?: string;
  /** 通知内のリンク先。未設定ならリンクを出さない。 */
  APP_URL?: string;
  /** 1回の起動で扱う監視対象の上限（wrangler.toml の vars）。 */
  MAX_MONITORS_PER_RUN?: string;
  /** 同時に投げるチェックの数（wrangler.toml の vars）。 */
  CHECK_CONCURRENCY?: string;
  /** 観測ログの保持日数（wrangler.toml の vars）。 */
  CHECK_RETENTION_DAYS?: string;
  /** 1回の起動で検査する証明書の数（wrangler.toml の vars）。 */
  MAX_CERTIFICATES_PER_RUN?: string;
};

type Client = SupabaseClient<Database>;

/**
 * 監視対象に送る User-Agent。
 *
 * 相手のアクセスログに「これは監視で、誰が動かしているか」が残るようにする。
 * 素性の分からない定期アクセスは、受け取る側からは攻撃と区別がつかない。
 */
const USER_AGENT = 'StatusPulse/1.0 (+https://github.com/7g3n/statuspulse)';

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function createSupabaseClient(env: Env): Client {
  // 定期処理にはログインユーザーがいないため service_role で接続する。
  // このキーは Worker の secret としてのみ存在し、ブラウザには決して渡らない。
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/* -------------------------------------------------------------------------- */
/* 1件のチェック                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 監視対象に1回リクエストを投げ、観測結果を組み立てる。
 *
 * この関数は例外を投げない。ネットワークの失敗は「異常」という観測結果であって、
 * 定期処理そのものの失敗ではない。1件の失敗で他の対象のチェックを巻き込まないよう、
 * ここで必ず CheckObservation に変換して返す。
 *
 * 計測しているのは「応答ヘッダが返ってくるまで」の時間。
 * fetch() が解決するのはヘッダ受信の時点で、本文の転送時間は含まれない。
 * 死活監視で見たいのは到達性と応答の速さなので、この定義で足りる。
 */
export async function runCheck(monitor: DueMonitorRow): Promise<CheckObservation> {
  const startedAt = Date.now();
  const expectedBody = monitor.expected_body_text;

  try {
    const response = await fetch(monitor.url, {
      method: monitor.method,
      redirect: 'follow',
      headers: {
        'user-agent': USER_AGENT,
        // 監視対象が返す古い応答を掴まないよう、中間のキャッシュを明示的に避ける。
        'cache-control': 'no-cache',
      },
      signal: AbortSignal.timeout(monitor.timeout_ms),
      // Cloudflare のエッジキャッシュも通さない。
      // キャッシュが返ってくると「落ちているのに 200」になり、監視として成立しない。
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    const responseTimeMs = Date.now() - startedAt;

    // 本文を読むのは、チェックする文字列が設定されている対象だけ。
    // 毎回すべて読むと、監視のためだけに全対象ぶんの転送量と
    // Worker の実行時間を消費し続けることになる。
    if (expectedBody === null) {
      // 読まない場合も、開いたままにすると接続が解放されない。
      await response.body?.cancel();
      return observeResponse(response.status, responseTimeMs, monitor.expected_status_code);
    }

    const text = await readBody(response);

    return observeResponse(response.status, responseTimeMs, monitor.expected_status_code, {
      text,
      expected: expectedBody,
    });
  } catch (error) {
    const kind = classifyFetchError(error);
    const message = error instanceof Error ? error.message : String(error);

    if (kind === 'timeout') {
      return observeFailure(kind, `${monitor.timeout_ms}ms 以内に応答がありませんでした`);
    }

    // 分類できなかった場合、実行環境が返す文言は利用者にとって意味を成さないことが多い
    // （ローカルの workerd は DNS の失敗も 'internal error; reference = …' で返す）。
    // 何が起きたかを日本語で添えたうえで、原文も追えるよう括弧で残す。
    if (kind === 'unknown') {
      return observeFailure(kind, `リクエストを完了できませんでした（${message}）`);
    }

    return observeFailure(kind, message);
  }
}

/**
 * 本文を上限まで読む。
 *
 * response.text() をそのまま呼ばないのは、相手が巨大なファイルを返している場合に
 * Worker のメモリと実行時間を使い切ってしまうため。
 * 監視の設定に書く文字列はページの先頭近くにあるのが普通なので、上限で切って構わない。
 */
async function readBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (total < MAX_BODY_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
      }
    }
  } finally {
    // 上限で打ち切った場合、残りは読まずに接続を閉じる。
    await reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    merged.set(chunk, at);
    at += chunk.length;
  }

  // 文字化けしても includes の判定には影響しない範囲なので、UTF-8 として読む。
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(
    merged.subarray(0, MAX_BODY_BYTES),
  );
}

/**
 * 観測結果を記録し、監視対象の状態を進める。
 *
 * 記録は DB 側の record_check() が1トランザクションで行う。
 * 「checks に追記したが monitors を更新できなかった」という中間状態を作らないため。
 */
async function saveCheck(
  supabase: Client,
  monitor: DueMonitorRow,
  observation: CheckObservation,
): Promise<RecordCheckResult> {
  const { data, error } = await supabase.rpc('record_check', {
    p_monitor_id: monitor.id,
    p_result: observation.result,
    p_status_code: observation.statusCode,
    p_response_time_ms: observation.responseTimeMs,
    p_error_kind: observation.errorKind,
    p_error_message: observation.errorMessage,
  });

  if (error) throw new Error(`チェック結果の記録に失敗しました: ${error.message}`);
  return data as unknown as RecordCheckResult;
}

/* -------------------------------------------------------------------------- */
/* Slack 通知                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Slack へ送る。
 *
 * Webhook が未設定なら、組み立てた内容をログに出して 'skipped' を返す。
 * 通知先が無いだけで定期処理全体を失敗させない（監視の判定そのものは動いていてほしい）。
 */
async function sendToSlack(env: Env, message: SlackMessage): Promise<'sent' | 'skipped'> {
  if (!env.SLACK_WEBHOOK_URL) {
    console.log('[slack 未設定のため送信せず]', message.text);
    return 'skipped';
  }

  const response = await fetch(env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    throw new Error(`Slack への送信に失敗しました: ${response.status} ${await response.text()}`);
  }

  return 'sent';
}

export type NotifyOutcome = 'sent' | 'skipped' | 'duplicate' | 'failed';

/**
 * 状態が変わったときに1通だけ通知する。
 *
 * **送信より先に DB へ記録する。** claim_notification() が false を返したら
 * 既に誰かが送っている（か、送ろうとしている）ので、何もしない。
 *
 * 逆順（送ってから記録）にすると、送信成功後に記録へ失敗したときに二重送信になる。
 * この順序だと送信失敗時に通知が欠けるが、欠けたことは status = 'failed' として
 * 画面に残るので、黙って消えることはない。
 *
 * 重複判定の鍵は incident の ID から作る。時刻で追う方式は、
 * 実行が飛べば取りこぼし、二度走れば重複する。
 */
async function notifyTransition(
  env: Env,
  supabase: Client,
  monitor: DueMonitorRow,
  observation: CheckObservation,
  recorded: RecordCheckResult,
  now: Date,
): Promise<NotifyOutcome | null> {
  if (recorded.event === null || recorded.incident_id === null) return null;

  const isDown = recorded.event === 'went_down';
  const dedupeKey = isDown
    ? downDedupeKey(recorded.incident_id)
    : recoveredDedupeKey(recorded.incident_id);

  const { data: claimed, error: claimError } = await supabase.rpc('claim_notification', {
    p_kind: isDown ? 'monitor_down' : 'monitor_recovered',
    p_dedupe_key: dedupeKey,
    p_monitor_id: monitor.id,
    p_incident_id: recorded.incident_id,
    p_payload: { monitor_name: monitor.name, url: monitor.url, event: recorded.event },
  });

  if (claimError) throw new Error(`通知の記録に失敗しました: ${claimError.message}`);
  if (claimed !== true) return 'duplicate';

  const startedAt = recorded.incident_started_at ?? now.toISOString();

  const message = isDown
    ? buildDownMessage(
        {
          monitorName: monitor.name,
          url: monitor.url,
          cause: observation.errorKind ?? 'unknown',
          statusCode: observation.statusCode,
          errorMessage: observation.errorMessage,
          startedAt,
          failureCount: recorded.consecutive_failures,
          failureThreshold: recorded.failure_threshold,
          intervalSeconds: monitor.interval_seconds,
        },
        { appUrl: env.APP_URL },
      )
    : buildRecoveredMessage(
        {
          monitorName: monitor.name,
          url: monitor.url,
          startedAt,
          endedAt: now.toISOString(),
          downtimeSeconds: incidentDurationSeconds(
            { startedAt, endedAt: now.toISOString() },
            now.getTime(),
          ),
        },
        { appUrl: env.APP_URL },
      );

  try {
    const outcome = await sendToSlack(env, message);
    await supabase.rpc('settle_notification', { p_dedupe_key: dedupeKey, p_status: outcome });
    return outcome;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await supabase.rpc('settle_notification', {
      p_dedupe_key: dedupeKey,
      p_status: 'failed',
      p_error_message: reason,
    });
    // 通知の失敗でチェックそのものを失敗させない。記録は残っているので後から追える。
    console.error('通知の送信に失敗しました', reason);
    return 'failed';
  }
}

/* -------------------------------------------------------------------------- */
/* TLS 証明書の期限（Phase 4）                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 証明書の有効期限を取る。
 *
 * **なぜこんなことをしているのか**
 *   Cloudflare Workers の fetch() は相手の証明書を見せてくれず、Node の tls も無い。
 *   この実行環境に「証明書の期限を知る」手段が用意されていないので、
 *   生の TCP を開いて TLS ハンドシェイクを自分で始め、サーバーが返す
 *   Certificate メッセージを読む。
 *
 *   ハンドシェイクは完了させない。証明書を受け取った時点で目的は果たされるので、
 *   そこで接続を閉じる（鍵交換も検証もこちらではしない）。
 *
 * 組み立てと解析は @statuspulse/core の tls.ts にある純粋関数で、
 * ここが持つのはソケットの開閉と読み書きだけ。
 */
export async function fetchCertificate(
  hostname: string,
  port = 443,
  timeoutMs = 8000,
): Promise<{ expiresAt: string; issuer: string | null }> {
  const socket = connect({ hostname, port }, { secureTransport: 'off', allowHalfOpen: false });

  try {
    const writer = socket.writable.getWriter();
    await writer.write(buildClientHello(hostname));
    writer.releaseLock();

    const reader = socket.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const deadline = Date.now() + timeoutMs;

    try {
      // 証明書チェーンは数 KB になる。64KB 読んで見つからなければ諦める。
      while (total < 64 * 1024) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('証明書の取得がタイムアウトしました');

        const { value, done } = await withTimeout(reader.read(), remaining);
        if (done) break;
        if (!value || value.length === 0) continue;

        chunks.push(value);
        total += value.length;

        const der = extractCertificateDer(mergeChunks(chunks, total));
        if (der) {
          const info = parseCertificate(der);
          return { expiresAt: info.notAfter.toISOString(), issuer: info.issuer };
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    throw new Error('Certificate メッセージが見つかりませんでした');
  } finally {
    await socket.close().catch(() => undefined);
  }
}

function mergeChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    merged.set(chunk, at);
    at += chunk.length;
  }
  return merged;
}

/** ソケットの読み取りには AbortSignal が使えないので、競争で打ち切る。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('証明書の取得がタイムアウトしました')), ms),
    ),
  ]);
}

export type CertificateOutcome = {
  name: string;
  expiresAt: string | null;
  issuer: string | null;
  error?: string;
  notified?: NotifyOutcome | null;
};

/**
 * 期限が近い証明書を Slack に流す。
 *
 * 重複を防ぐ鍵に**証明書の期限そのもの**を含めるのが要点。
 * 証明書が更新されれば鍵が変わるので次の通知が届き、更新されない限り二度は鳴らない。
 * 「日付ごとに1回」にすると、更新されないまま毎日鳴り続けて読まれなくなる。
 */
async function notifyCertificate(
  env: Env,
  supabase: Client,
  monitor: { id: string; name: string; url: string },
  expiresAt: string,
  issuer: string | null,
): Promise<NotifyOutcome | null> {
  const thresholdDays = certificateAlertThreshold(expiresAt);
  if (thresholdDays === null) return null;

  const dedupeKey = certificateDedupeKey(monitor.id, expiresAt, thresholdDays);

  const { data: claimed, error } = await supabase.rpc('claim_notification', {
    p_kind: 'certificate_expiring',
    p_dedupe_key: dedupeKey,
    p_monitor_id: monitor.id,
    p_incident_id: null,
    p_payload: { monitor_name: monitor.name, expires_at: expiresAt, threshold: thresholdDays },
  });

  if (error) throw new Error(`通知の記録に失敗しました: ${error.message}`);
  if (claimed !== true) return 'duplicate';

  const message = buildCertificateMessage(
    { monitorName: monitor.name, url: monitor.url, expiresAt, issuer, thresholdDays },
    { appUrl: env.APP_URL },
  );

  try {
    const outcome = await sendToSlack(env, message);
    await supabase.rpc('settle_notification', { p_dedupe_key: dedupeKey, p_status: outcome });
    return outcome;
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    await supabase.rpc('settle_notification', {
      p_dedupe_key: dedupeKey,
      p_status: 'failed',
      p_error_message: reason,
    });
    return 'failed';
  }
}

/**
 * 証明書の検査。
 *
 * 到達性のチェックと分けてあるのは頻度がまったく違うため。
 * 有効期限は数か月単位で動くもので、1分ごとに確かめる意味がない。
 * 同じ処理に混ぜると、毎分の TLS ハンドシェイクを監視先に強いることになる。
 *
 * 失敗しても記録する。**取得できないこと自体が知りたい情報**で、
 * 黙って前回の値を残すと「期限は大丈夫」と誤読される。
 */
export async function runCertificateChecks(env: Env): Promise<CertificateOutcome[]> {
  const supabase = createSupabaseClient(env);
  const limit = numberFromEnv(env.MAX_CERTIFICATES_PER_RUN, 5);

  const { data, error } = await supabase.rpc('due_certificate_checks', { p_limit: limit });
  if (error) throw new Error(`証明書の検査対象の取得に失敗しました: ${error.message}`);

  const results: CertificateOutcome[] = [];

  for (const monitor of data ?? []) {
    try {
      const parsed = new URL(monitor.url);
      const certificate = await fetchCertificate(
        parsed.hostname,
        parsed.port ? Number(parsed.port) : 443,
      );

      await supabase.rpc('record_certificate', {
        p_monitor_id: monitor.id,
        p_expires_at: certificate.expiresAt,
        p_issuer: certificate.issuer,
        p_error: null,
      });

      const notified = await notifyCertificate(
        env,
        supabase,
        monitor,
        certificate.expiresAt,
        certificate.issuer,
      );

      results.push({
        name: monitor.name,
        expiresAt: certificate.expiresAt,
        issuer: certificate.issuer,
        notified,
      });
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : String(caught);

      // 期限は消さずに残さず、エラーだけを別の列に書く方針ではなく、
      // 取得できなかったことを明示する（前回の値を残すと「大丈夫」と誤読される）。
      await supabase.rpc('record_certificate', {
        p_monitor_id: monitor.id,
        p_expires_at: null,
        p_issuer: null,
        p_error: reason.slice(0, 300),
      });

      results.push({ name: monitor.name, expiresAt: null, issuer: null, error: reason });
    }
  }

  return results;
}

/* -------------------------------------------------------------------------- */
/* 実行の本体                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 同時実行数を制限しながら順に処理する。
 *
 * 直列だと、20 対象 × 最大 10 秒で Worker の実行時間に収まらない。
 * かといって Promise.all で全部同時に投げると、相手先にも Workers 側にも
 * 一度に負荷が集中する。決まった数だけ並べて流す形にする。
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  handler: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await handler(item);
    }
  });

  await Promise.all(workers);
  return results;
}

export type CheckedMonitor = {
  name: string;
  url: string;
  result: CheckObservation['result'];
  statusCode: number | null;
  responseTimeMs: number | null;
  status: RecordCheckResult['status'];
  event: RecordCheckResult['event'];
  /** 通知の結果。状態が変わらなかった回は null。 */
  notified?: NotifyOutcome | null;
  /** 記録そのものに失敗した場合のメッセージ。次回の起動で再チェックされる。 */
  saveError?: string;
};

export type RunResult = {
  due: number;
  checked: number;
  up: number;
  down: number;
  /** 状態が変化した対象。Phase 2 の Slack 通知はここを起点にする。 */
  transitions: CheckedMonitor[];
  monitors: CheckedMonitor[];
};

/** 定期処理の本体。fetch ハンドラからも呼べるように切り出してある。 */
export async function runChecks(env: Env, now = new Date()): Promise<RunResult> {
  const supabase = createSupabaseClient(env);
  const limit = numberFromEnv(env.MAX_MONITORS_PER_RUN, 20);
  const concurrency = numberFromEnv(env.CHECK_CONCURRENCY, 5);

  // 「今チェックすべき対象」の判定は DB 側に置く。
  // 全件を取得してから Worker で絞ると、対象が増えたときに毎分全件を運ぶことになる。
  const { data, error } = await supabase.rpc('due_monitors', {
    p_tolerance_seconds: 30,
    p_limit: limit,
  });

  if (error) throw new Error(`チェック対象の取得に失敗しました: ${error.message}`);

  const due = (data ?? []) as DueMonitorRow[];

  const checked = await mapWithConcurrency(due, concurrency, async (monitor) => {
    const observation = await runCheck(monitor);

    try {
      const recorded = await saveCheck(supabase, monitor, observation);

      // 通知は「状態が変わった回」だけ。継続中の障害では鳴らさない。
      const notified = await notifyTransition(env, supabase, monitor, observation, recorded, now);

      return {
        name: monitor.name,
        url: monitor.url,
        result: observation.result,
        statusCode: observation.statusCode,
        responseTimeMs: observation.responseTimeMs,
        status: recorded.status,
        event: recorded.event,
        notified,
      } satisfies CheckedMonitor;
    } catch (saveError) {
      // 記録に失敗しても他の対象の処理は続ける。
      // last_checked_at が進まないので、この対象は次の起動で再びチェックされる。
      return {
        name: monitor.name,
        url: monitor.url,
        result: observation.result,
        statusCode: observation.statusCode,
        responseTimeMs: observation.responseTimeMs,
        status: monitor.current_status,
        event: null,
        saveError: saveError instanceof Error ? saveError.message : String(saveError),
      } satisfies CheckedMonitor;
    }
  });

  return {
    due: due.length,
    checked: checked.length,
    up: checked.filter((item) => item.result === 'up').length,
    down: checked.filter((item) => item.result === 'down').length,
    transitions: checked.filter((item) => item.event !== null),
    monitors: checked,
  };
}

/**
 * 保持期間を過ぎた観測ログの削除。
 *
 * 毎分走らせる必要はないので、UTC 18:00（JST 03:00）の回だけ実行する。
 * 削除は冪等なので、同じ時刻に二度走っても2回目は0行になるだけで害はない。
 */
async function purgeIfScheduled(env: Env, now: Date): Promise<number | null> {
  if (now.getUTCHours() !== 18 || now.getUTCMinutes() !== 0) return null;

  const supabase = createSupabaseClient(env);
  const retentionDays = numberFromEnv(env.CHECK_RETENTION_DAYS, 30);

  const { data, error } = await supabase.rpc('purge_old_checks', {
    p_retention_days: retentionDays,
  });

  if (error) throw new Error(`古い観測ログの削除に失敗しました: ${error.message}`);
  return Number(data ?? 0);
}

export default {
  /**
   * Cron Triggers から呼ばれる入口。wrangler.toml の crons で毎分に設定している。
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const result = await runChecks(env);

        if (result.transitions.length > 0) {
          console.log('状態が変化した対象', JSON.stringify(result.transitions));
        }

        const scheduledAt = new Date(event.scheduledTime);

        // 証明書の検査は毎時 0 分の回だけ。1日1回で足りるが、
        // 1回の起動で扱う数に上限があるので、時間ごとに少しずつ消化する。
        const certificates =
          scheduledAt.getUTCMinutes() === 0 ? await runCertificateChecks(env) : null;

        if (certificates && certificates.length > 0) {
          console.log('証明書の検査', JSON.stringify(certificates));
        }

        const purged = await purgeIfScheduled(env, scheduledAt);

        console.log(
          JSON.stringify({
            due: result.due,
            checked: result.checked,
            up: result.up,
            down: result.down,
            ...(purged === null ? {} : { purged }),
          }),
        );
      })().catch((error: unknown) => {
        // 失敗しても次回の起動で回復する（last_checked_at が進んでいない対象は再チェックされる）。
        console.error('定期チェックに失敗しました', error);
        throw error;
      }),
    );
  },

  /**
   * 手動確認用。`wrangler dev` 中に GET すると、その時点の判定結果を返す。
   * 毎分の起動を待たずに動作を確かめられるようにしておく。
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      // 証明書の検査は毎時 0 分の回しか回らないので、手で確かめる入口を分けておく。
      if (new URL(request.url).pathname === '/certificates') {
        return Response.json(await runCertificateChecks(env));
      }
      return Response.json(await runChecks(env));
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
