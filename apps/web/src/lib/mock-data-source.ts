/**
 * Supabase を立てずに画面を動かすためのデータ源。
 *
 * `pnpm dev:mock` で有効になる。デモ、スクリーンショット、
 * および DB を用意していない環境での動作確認に使う。
 *
 * 作り方の方針:
 *   supabase/seed.sql と同じ性格のデータを、同じ考え方で作る。
 *   （常時正常なもの / 短い障害が数回あったもの / 今まさに落ちているもの / 無効なもの）
 *
 *   状態の判定には本番と同じ nextMonitorState() を通し、
 *   稼働率の集計も monitor_overview ビューと同じ数え方をする。
 *   モックだけ都合よく計算すると、モックで確かめた意味が無くなる。
 *
 *   時刻は「今」からの相対で作るので、いつ起動しても直近7日ぶんが埋まっている。
 *   ゆらぎは決定的なハッシュから作り、乱数を使わない（毎回同じ画面になる）。
 */
import type {
  CheckErrorKind,
  CheckResult,
  CheckRow,
  HttpMethod,
  IncidentOverviewRow,
  MonitorFormValues,
  MonitorOverviewRow,
  MonitorState,
  RecentCheckRow,
} from '@statuspulse/core';
import {
  incidentDurationSeconds,
  nextMonitorState,
  normalizeMonitorValues,
  totalDowntimeSeconds,
} from '@statuspulse/core';

import type { DashboardData, DataSource, SessionUser } from './data-source';
import { RECENT_CHECK_COUNT } from './data-source';

const DEMO_USER: SessionUser = {
  id: '00000000-0000-0000-0000-0000000000a1',
  email: 'demo@statuspulse.test',
  displayName: 'デモユーザー',
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** 決定的なゆらぎ。同じ入力からは必ず同じ値が出る（FNV-1a）。 */
function hash(input: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return Math.abs(value);
}

type Incident = {
  /** 「今」から何ミリ秒前に始まったか。 */
  startsAgoMs: number;
  endsAgoMs: number;
  errorKind: CheckErrorKind;
  statusCode: number | null;
  message: string;
};

type MockMonitor = {
  id: string;
  name: string;
  url: string;
  method: HttpMethod;
  expectedStatusCode: number | null;
  intervalSeconds: number;
  timeoutMs: number;
  isEnabled: boolean;
  failureThreshold: number;
  baseResponseMs: number;
  incidents: Incident[];
  createdAtMs: number;
};

/** seed.sql と同じ顔ぶれ。1つ目は StockDesk のデプロイ先（差し替え前提のプレースホルダ）。 */
function initialMonitors(now: number): MockMonitor[] {
  const createdAtMs = now - 30 * 24 * HOUR_MS;

  return [
    {
      id: '00000000-0000-0000-0000-0000000000b1',
      name: 'StockDesk（本番）',
      url: 'https://stockdesk.example.com/',
      method: 'GET',
      expectedStatusCode: null,
      intervalSeconds: 300,
      timeoutMs: 10_000,
      isEnabled: true,
      // ここだけ 3 にしてある。5日前の32分の障害はインシデントになるが、
      // 2日前の10分の瞬断（5分間隔なので2回）は閾値に届かず無視される。
      // 「誤検知を減らす」設定が実際に何を落とすのかを画面で見せるため。
      failureThreshold: 3,
      baseResponseMs: 180,
      createdAtMs,
      incidents: [
        {
          startsAgoMs: 5 * 24 * HOUR_MS + 2 * HOUR_MS,
          endsAgoMs: 5 * 24 * HOUR_MS + 88 * MINUTE_MS,
          errorKind: 'status',
          statusCode: 502,
          message: 'HTTP 502 が返りました',
        },
        {
          startsAgoMs: 2 * 24 * HOUR_MS,
          endsAgoMs: 2 * 24 * HOUR_MS - 10 * MINUTE_MS,
          errorKind: 'timeout',
          statusCode: null,
          message: '10000ms 以内に応答がありませんでした',
        },
      ],
    },
    {
      id: '00000000-0000-0000-0000-0000000000b2',
      name: 'StockDesk API（ヘルスチェック）',
      url: 'https://stockdesk.example.com/api/health',
      method: 'GET',
      expectedStatusCode: 200,
      intervalSeconds: 300,
      timeoutMs: 5_000,
      isEnabled: true,
      failureThreshold: 2,
      baseResponseMs: 90,
      createdAtMs,
      incidents: [
        {
          startsAgoMs: 5 * 24 * HOUR_MS + 2 * HOUR_MS,
          endsAgoMs: 5 * 24 * HOUR_MS + 80 * MINUTE_MS,
          errorKind: 'status',
          statusCode: 503,
          message: 'HTTP 503 が返りました（期待: 200）',
        },
      ],
    },
    {
      id: '00000000-0000-0000-0000-0000000000b3',
      name: 'ポートフォリオサイト',
      url: 'https://portfolio.example.com/',
      method: 'HEAD',
      expectedStatusCode: null,
      intervalSeconds: 900,
      timeoutMs: 10_000,
      isEnabled: true,
      failureThreshold: 2,
      baseResponseMs: 45,
      createdAtMs,
      // 障害なし。稼働率 100% の見え方を確かめるため。
      incidents: [],
    },
    {
      id: '00000000-0000-0000-0000-0000000000b4',
      name: '画像配信 CDN',
      url: 'https://cdn.example.com/health.txt',
      method: 'GET',
      expectedStatusCode: 200,
      intervalSeconds: 300,
      timeoutMs: 3_000,
      isEnabled: true,
      failureThreshold: 2,
      baseResponseMs: 60,
      createdAtMs,
      incidents: [
        // 現在も継続中の障害（終了時刻を未来に置く）。
        {
          startsAgoMs: 38 * MINUTE_MS,
          endsAgoMs: -24 * HOUR_MS,
          errorKind: 'dns',
          statusCode: null,
          message: '名前解決に失敗しました',
        },
      ],
    },
    {
      id: '00000000-0000-0000-0000-0000000000b5',
      name: '検証環境（stg）',
      url: 'https://stg.stockdesk.example.com/',
      method: 'GET',
      expectedStatusCode: null,
      intervalSeconds: 1800,
      timeoutMs: 10_000,
      isEnabled: false,
      failureThreshold: 2,
      baseResponseMs: 210,
      createdAtMs,
      incidents: [],
    },
  ];
}

/** 直近7日ぶんのチェックを作る。古い順に並ぶ。 */
function generateChecks(monitor: MockMonitor, now: number): CheckRow[] {
  const stepMs = monitor.intervalSeconds * 1000;
  const checks: CheckRow[] = [];
  let id = 1;

  // 時刻を間隔の境界に合わせる。
  // 「今」で打ち切ると全対象の最終チェックが揃って「0秒前」になり、
  // 実際の動き（間隔ごとに順番に回る）と見え方が変わってしまう。
  const latestAt = Math.floor(now / stepMs) * stepMs;

  // 無効化された対象は、無効にする前の履歴だけを持っている状態にする。
  const stopAt = monitor.isEnabled ? latestAt : latestAt - 3 * 24 * HOUR_MS;

  for (let at = latestAt - WEEK_MS; at <= stopAt; at += stepMs) {
    const incident = monitor.incidents.find(
      (item) => at >= now - item.startsAgoMs && at < now - item.endsAgoMs,
    );

    const result: CheckResult = incident ? 'down' : 'up';
    const jitter = hash(`${monitor.id}:${at}`) % 70;

    checks.push({
      id: id++,
      monitor_id: monitor.id,
      checked_at: new Date(at).toISOString(),
      result,
      status_code: incident ? incident.statusCode : 200,
      // 応答が返らなかったチェックは応答時間を持たない。
      response_time_ms:
        incident && incident.statusCode === null ? null : monitor.baseResponseMs + jitter,
      error_kind: incident ? incident.errorKind : null,
      error_message: incident ? incident.message : null,
    });
  }

  return checks;
}

type Replayed = {
  state: MonitorState;
  statusChangedAt: string | null;
  firstFailureAt: string | null;
  incidents: IncidentOverviewRow[];
};

/** まだ一度もチェックされていない対象（登録直後）の再生結果。 */
const EMPTY_REPLAY: Replayed = {
  state: { status: 'unknown', consecutiveFailures: 0 },
  statusChangedAt: null,
  firstFailureAt: null,
  incidents: [],
};

/**
 * 履歴から現在の状態とインシデントを導く。
 *
 * 本番と同じ nextMonitorState() を先頭から順に通し、record_check() と同じ規則で
 * インシデントを開閉する。モック専用の判定を書くと、画面で確かめているものが
 * 本番の挙動と別物になる。
 *
 * インシデントの開始時刻に firstFailureAt を使うところも本番と同じ。
 * 閾値が 2 以上のとき、判定が確定するのは N 回目だが、落ちていたのは1回目から。
 */
function replay(monitor: MockMonitor, checks: readonly CheckRow[]): Replayed {
  let state: MonitorState = { status: 'unknown', consecutiveFailures: 0 };
  let statusChangedAt: string | null = null;
  let firstFailureAt: string | null = null;
  let open: IncidentOverviewRow | null = null;
  const incidents: IncidentOverviewRow[] = [];

  for (const check of checks) {
    const next = nextMonitorState(state, check.result, monitor.failureThreshold);

    if (check.result === 'up') {
      firstFailureAt = null;
      if (open) {
        open.ended_at = check.checked_at;
        open = null;
      }
    } else {
      firstFailureAt ??= check.checked_at;

      if (next.event === 'went_down') {
        open = {
          id: `${monitor.id}-${incidents.length + 1}`,
          monitor_id: monitor.id,
          monitor_name: monitor.name,
          monitor_url: monitor.url,
          monitor_is_enabled: monitor.isEnabled,
          started_at: firstFailureAt,
          ended_at: null,
          cause: check.error_kind ?? 'unknown',
          status_code: check.status_code,
          error_message: check.error_message,
          failure_count: next.consecutiveFailures,
          duration_seconds: 0,
          // モックには定期処理がいないので、送信済みとして見せる。
          down_notification_status: 'sent',
          recovered_notification_status: null,
        };
        incidents.push(open);
      } else if (open) {
        open.failure_count += 1;
      }
    }

    if (next.status !== state.status) statusChangedAt = check.checked_at;
    state = { status: next.status, consecutiveFailures: next.consecutiveFailures };
  }

  for (const incident of incidents) {
    incident.duration_seconds = Math.round(
      incidentDurationSeconds({ startedAt: incident.started_at, endedAt: incident.ended_at }),
    );
    if (incident.ended_at !== null) incident.recovered_notification_status = 'sent';
  }

  return { state, statusChangedAt, firstFailureAt, incidents };
}

/** monitor_overview ビューと同じ数え方で集計する。 */
function buildOverview(
  monitor: MockMonitor,
  checks: readonly CheckRow[],
  replayed: Replayed,
  now: number,
): MonitorOverviewRow {
  const dayAgo = now - 24 * HOUR_MS;
  const weekAgo = now - WEEK_MS;
  const within24h = checks.filter((check) => Date.parse(check.checked_at) >= dayAgo);
  const responseTimes = within24h
    .map((check) => check.response_time_ms)
    .filter((value): value is number => value !== null);

  const { state, statusChangedAt, firstFailureAt, incidents } = replayed;

  const periods = incidents.map((incident) => ({
    startedAt: incident.started_at,
    endedAt: incident.ended_at,
  }));

  const latest = checks[checks.length - 1];

  return {
    id: monitor.id,
    owner_id: DEMO_USER.id,
    name: monitor.name,
    url: monitor.url,
    method: monitor.method,
    expected_status_code: monitor.expectedStatusCode,
    interval_seconds: monitor.intervalSeconds,
    timeout_ms: monitor.timeoutMs,
    is_enabled: monitor.isEnabled,
    current_status: state.status,
    consecutive_failures: state.consecutiveFailures,
    failure_threshold: monitor.failureThreshold,
    first_failure_at: firstFailureAt,
    last_checked_at: latest?.checked_at ?? null,
    status_changed_at: statusChangedAt,
    created_at: new Date(monitor.createdAtMs).toISOString(),
    updated_at: new Date(monitor.createdAtMs).toISOString(),
    checks_24h: within24h.length,
    up_24h: within24h.filter((check) => check.result === 'up').length,
    checks_7d: checks.length,
    up_7d: checks.filter((check) => check.result === 'up').length,
    avg_response_time_ms:
      responseTimes.length === 0
        ? null
        : Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length),

    // ビューと同じく、期間と重なるぶんだけを足す。
    down_seconds_24h: Math.round(totalDowntimeSeconds(periods, dayAgo, now)),
    down_seconds_7d: Math.round(totalDowntimeSeconds(periods, weekAgo, now)),
    incidents_7d: incidents.filter(
      (incident) => Date.parse(incident.ended_at ?? new Date(now).toISOString()) >= weekAgo,
    ).length,
    open_incident_id: incidents.find((incident) => incident.ended_at === null)?.id ?? null,

    last_status_code: latest?.status_code ?? null,
    last_response_time_ms: latest?.response_time_ms ?? null,
    last_error_kind: latest?.error_kind ?? null,
    last_error_message: latest?.error_message ?? null,
  };
}

function toRecentCheck(check: CheckRow): RecentCheckRow {
  return {
    monitor_id: check.monitor_id,
    checked_at: check.checked_at,
    result: check.result,
    status_code: check.status_code,
    response_time_ms: check.response_time_ms,
    error_kind: check.error_kind,
  };
}

export function createMockDataSource(): DataSource {
  const now = Date.now();
  const monitors = initialMonitors(now);
  const checksByMonitor = new Map<string, CheckRow[]>(
    monitors.map((monitor) => [monitor.id, generateChecks(monitor, now)]),
  );

  // 再生は一度だけ。7日ぶんのチェックを画面の描画ごとに流し直す必要はない。
  const replayByMonitor = new Map<string, Replayed>(
    monitors.map((monitor) => [monitor.id, replay(monitor, checksByMonitor.get(monitor.id) ?? [])]),
  );

  let currentUser: SessionUser | null = DEMO_USER;
  const listeners = new Set<(user: SessionUser | null) => void>();

  function notify() {
    for (const listener of listeners) listener(currentUser);
  }

  function findMonitor(monitorId: string): MockMonitor {
    const monitor = monitors.find((item) => item.id === monitorId);
    if (!monitor) throw new Error('監視対象が見つかりません');
    return monitor;
  }

  function applyValues(monitor: MockMonitor, input: MonitorFormValues): void {
    const values = normalizeMonitorValues(input);
    monitor.name = values.name;
    monitor.url = values.url;
    monitor.method = values.method;
    monitor.expectedStatusCode = values.expectedStatusCode;
    monitor.intervalSeconds = values.intervalSeconds;
    monitor.timeoutMs = values.timeoutMs;
    monitor.failureThreshold = values.failureThreshold;
    monitor.isEnabled = values.isEnabled;
  }

  return {
    kind: 'mock',

    async getSession() {
      return currentUser;
    },

    onAuthStateChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async signIn() {
      currentUser = DEMO_USER;
      notify();
    },

    async signUp() {
      currentUser = DEMO_USER;
      notify();
    },

    async signOut() {
      currentUser = null;
      notify();
    },

    async loadDashboard(): Promise<DashboardData> {
      const overviews = monitors.map((monitor) =>
        buildOverview(
          monitor,
          checksByMonitor.get(monitor.id) ?? [],
          replayByMonitor.get(monitor.id) ?? EMPTY_REPLAY,
          now,
        ),
      );

      // 本番と同じ並び（異常なものを上に、その中では名前順）。
      const order = { down: 0, unknown: 1, up: 2 } as const;
      overviews.sort(
        (a, b) =>
          order[a.current_status] - order[b.current_status] || a.name.localeCompare(b.name, 'ja'),
      );

      const recentChecks: DashboardData['recentChecks'] = {};
      for (const monitor of monitors) {
        const checks = checksByMonitor.get(monitor.id) ?? [];
        recentChecks[monitor.id] = checks.slice(-RECENT_CHECK_COUNT).map(toRecentCheck);
      }

      return { monitors: overviews, recentChecks };
    },

    async loadMonitorChecks(monitorId, limit) {
      const checks = checksByMonitor.get(monitorId) ?? [];
      return checks.slice(-limit).reverse();
    },

    async loadIncidents({ monitorId, limit }) {
      const all = monitorId
        ? (replayByMonitor.get(monitorId)?.incidents ?? [])
        : monitors.flatMap((monitor) => replayByMonitor.get(monitor.id)?.incidents ?? []);

      return [...all]
        .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
        .slice(0, limit);
    },

    async createMonitor(input) {
      const values = normalizeMonitorValues(input);

      if (monitors.some((monitor) => monitor.url === values.url)) {
        throw new Error('同じ URL の監視対象がすでに登録されています');
      }

      const monitor: MockMonitor = {
        id: crypto.randomUUID(),
        name: values.name,
        url: values.url,
        method: values.method,
        expectedStatusCode: values.expectedStatusCode,
        intervalSeconds: values.intervalSeconds,
        timeoutMs: values.timeoutMs,
        isEnabled: values.isEnabled,
        failureThreshold: values.failureThreshold,
        baseResponseMs: 120,
        incidents: [],
        createdAtMs: Date.now(),
      };

      monitors.push(monitor);
      // 登録直後はまだ一度もチェックされていない（画面上は「未チェック」になる）。
      checksByMonitor.set(monitor.id, []);
      replayByMonitor.set(monitor.id, EMPTY_REPLAY);
    },

    async updateMonitor(monitorId, values) {
      applyValues(findMonitor(monitorId), values);
    },

    async deleteMonitor(monitorId) {
      const index = monitors.findIndex((monitor) => monitor.id === monitorId);
      if (index >= 0) monitors.splice(index, 1);
      checksByMonitor.delete(monitorId);
      replayByMonitor.delete(monitorId);
    },
  };
}
