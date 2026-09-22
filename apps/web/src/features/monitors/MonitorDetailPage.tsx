import {
  CHECK_ERROR_KIND_LABELS,
  CHECK_INTERVAL_LABELS,
  detectionDelaySeconds,
  displayUrl,
  formatDowntime,
  formatResponseTime,
  isCheckInterval,
  observedWindowSeconds,
  timeBasedUptime,
  WINDOW_SECONDS,
} from '@statuspulse/core';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { StatusBadge, UptimeValue } from '@/components/badges';
import { Button, Card, EmptyBlock, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui';
import { useDashboard } from '@/features/dashboard/api';
import { useIncidents } from '@/features/incidents/api';
import { IncidentTimeline } from '@/features/incidents/IncidentTimeline';
import { formatDateTime, formatDuration } from '@/lib/format';

import { MonitorFormDialog } from './MonitorFormDialog';
import { MONITOR_CHECK_HISTORY_LIMIT, useDeleteMonitor, useMonitorChecks } from './api';

/**
 * 監視対象の詳細。
 *
 * 監視対象そのものは一覧のクエリ（monitor_overview）から取り出す。
 * 1件だけを取る別の問い合わせを足さないのは、一覧を開いた直後に遷移する導線しかなく、
 * ほぼ確実にキャッシュが温まっているため。
 * 直接 URL を開いた場合は一覧のクエリがそのまま走るので、どちらでも表示できる。
 */
export function MonitorDetailPage() {
  const { monitorId = '' } = useParams();
  const navigate = useNavigate();

  const dashboard = useDashboard();
  const checks = useMonitorChecks(monitorId);
  const incidents = useIncidents(monitorId);
  const deleteMonitor = useDeleteMonitor();

  const [editOpen, setEditOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (dashboard.isPending) {
    return (
      <Card>
        <LoadingBlock />
      </Card>
    );
  }

  if (dashboard.error) {
    return (
      <Card>
        <ErrorBlock error={dashboard.error} onRetry={() => void dashboard.refetch()} />
      </Card>
    );
  }

  const monitor = dashboard.data?.monitors.find((item) => item.id === monitorId);

  if (!monitor) {
    return (
      <Card>
        <EmptyBlock
          title="監視対象が見つかりません"
          description="削除されたか、URL が正しくない可能性があります。"
          action={
            <Link to="/">
              <Button>ダッシュボードへ戻る</Button>
            </Link>
          }
        />
      </Card>
    );
  }

  const ratio24h = timeBasedUptime(
    monitor.down_seconds_24h,
    observedWindowSeconds(monitor.created_at, WINDOW_SECONDS.day),
  );
  const ratio7d = timeBasedUptime(
    monitor.down_seconds_7d,
    observedWindowSeconds(monitor.created_at, WINDOW_SECONDS.week),
  );
  const interval = isCheckInterval(monitor.interval_seconds)
    ? CHECK_INTERVAL_LABELS[monitor.interval_seconds]
    : `${monitor.interval_seconds}秒`;

  const detectionDelay = detectionDelaySeconds(monitor.interval_seconds, monitor.failure_threshold);

  async function onDelete() {
    await deleteMonitor.mutateAsync(monitorId);
    void navigate('/');
  }

  return (
    <div className="space-y-6">
      <div>
        <Link to="/" className="text-xs text-slate-500 hover:text-brand-700 hover:underline">
          ← ダッシュボード
        </Link>
      </div>

      <PageHeader
        title={monitor.name}
        description={`${monitor.method} ${displayUrl(monitor.url)}`}
        actions={
          <>
            <Button onClick={() => setEditOpen(true)}>編集</Button>
            <Button variant="danger" onClick={() => setConfirmingDelete(true)}>
              削除
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="px-4 py-3">
          <p className="text-xs text-slate-500">現在の状態</p>
          <div className="mt-2">
            <StatusBadge status={monitor.current_status} isEnabled={monitor.is_enabled} />
          </div>
          {monitor.is_enabled && monitor.status_changed_at && (
            <p className="mt-1.5 text-xs text-slate-500">
              {formatDuration(monitor.status_changed_at)}継続
            </p>
          )}
        </Card>

        <Card className="px-4 py-3">
          <p className="text-xs text-slate-500">24時間の稼働率</p>
          <div className="mt-2">
            <UptimeValue ratio={ratio24h} downSeconds={monitor.down_seconds_24h} />
          </div>
          <p className="tabular mt-1.5 text-xs text-slate-400">{monitor.checks_24h} 回のチェック</p>
        </Card>

        <Card className="px-4 py-3">
          <p className="text-xs text-slate-500">7日間の稼働率</p>
          <div className="mt-2">
            <UptimeValue ratio={ratio7d} downSeconds={monitor.down_seconds_7d} />
          </div>
          <p className="tabular mt-1.5 text-xs text-slate-400">
            障害 {monitor.incidents_7d} 件 / {monitor.checks_7d} 回のチェック
          </p>
        </Card>

        <Card className="px-4 py-3">
          <p className="text-xs text-slate-500">平均応答時間（24時間）</p>
          <p className="tabular mt-2 text-sm font-semibold text-slate-900">
            {formatResponseTime(monitor.avg_response_time_ms)}
          </p>
        </Card>
      </div>

      <Card className="px-4 py-4">
        <h2 className="text-sm font-semibold text-slate-900">設定</h2>
        <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-4 border-b border-slate-100 py-1.5">
            <dt className="text-slate-500">チェック間隔</dt>
            <dd className="text-slate-900">{interval}</dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-slate-100 py-1.5">
            <dt className="text-slate-500">タイムアウト</dt>
            <dd className="tabular text-slate-900">{monitor.timeout_ms} ms</dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-slate-100 py-1.5">
            <dt className="text-slate-500">期待するステータス</dt>
            <dd className="text-slate-900">{monitor.expected_status_code ?? '2xx / 3xx'}</dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-slate-100 py-1.5">
            <dt className="text-slate-500">異常と判定する連続失敗回数</dt>
            <dd className="tabular text-slate-900">
              {monitor.failure_threshold} 回
              {detectionDelay > 0 && (
                <span className="ml-1.5 text-xs text-slate-400">
                  （検知が最大 {formatDowntime(detectionDelay)} 遅れる）
                </span>
              )}
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="px-5 py-5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-slate-900">ダウンタイム履歴</h2>
          <Link
            to="/incidents"
            className="text-xs text-slate-500 hover:text-brand-700 hover:underline"
          >
            すべての対象を見る
          </Link>
        </div>

        <div className="mt-4">
          {incidents.isPending ? (
            <LoadingBlock />
          ) : incidents.error ? (
            <ErrorBlock error={incidents.error} onRetry={() => void incidents.refetch()} />
          ) : (incidents.data ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">
              この対象が異常と判定されたことはありません。
            </p>
          ) : (
            <IncidentTimeline incidents={incidents.data ?? []} showMonitor={false} />
          )}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-baseline justify-between px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">チェック履歴</h2>
          <p className="text-xs text-slate-400">直近 {MONITOR_CHECK_HISTORY_LIMIT} 件</p>
        </div>

        {checks.isPending ? (
          <LoadingBlock />
        ) : checks.error ? (
          <ErrorBlock error={checks.error} onRetry={() => void checks.refetch()} />
        ) : (checks.data ?? []).length === 0 ? (
          <EmptyBlock
            title="まだチェックされていません"
            description="定期処理が次に動いたときに最初の結果が記録されます。"
          />
        ) : (
          <div className="overflow-x-auto border-t border-slate-100">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="text-xs text-slate-500">
                  <th className="py-2 pl-4 pr-3 text-left font-medium">時刻</th>
                  <th className="px-3 py-2 text-left font-medium">結果</th>
                  <th className="px-3 py-2 text-right font-medium">ステータス</th>
                  <th className="px-3 py-2 text-right font-medium">応答時間</th>
                  <th className="py-2 pl-3 pr-4 text-left font-medium">備考</th>
                </tr>
              </thead>
              <tbody>
                {(checks.data ?? []).map((check) => (
                  <tr key={check.id} className="border-t border-slate-100">
                    <td className="tabular py-2 pl-4 pr-3 text-xs text-slate-600">
                      {formatDateTime(check.checked_at)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          'text-xs font-medium ' +
                          (check.result === 'up' ? 'text-up-700' : 'text-down-700')
                        }
                      >
                        {check.result === 'up' ? '正常' : '異常'}
                      </span>
                    </td>
                    <td className="tabular px-3 py-2 text-right text-xs text-slate-600">
                      {check.status_code ?? '—'}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-xs text-slate-600">
                      {formatResponseTime(check.response_time_ms)}
                    </td>
                    <td className="py-2 pl-3 pr-4 text-xs text-slate-500">
                      {check.error_kind ? (
                        <>
                          <span className="text-down-700">
                            {CHECK_ERROR_KIND_LABELS[check.error_kind]}
                          </span>
                          {check.error_message && ` / ${check.error_message}`}
                        </>
                      ) : (
                        ''
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <MonitorFormDialog open={editOpen} monitor={monitor} onClose={() => setEditOpen(false)} />

      {confirmingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setConfirmingDelete(false)}
            aria-hidden="true"
          />
          <Card className="relative z-10 w-full max-w-sm p-5">
            <p className="text-sm font-semibold text-slate-900">この監視対象を削除しますか？</p>
            <p className="mt-2 text-sm text-slate-600">
              「{monitor.name}」のチェック履歴も一緒に削除され、稼働率の記録は復元できません。
              一時的に止めたいだけなら、編集画面で監視を無効にできます。
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button onClick={() => setConfirmingDelete(false)}>キャンセル</Button>
              <Button
                variant="danger"
                loading={deleteMonitor.isPending}
                onClick={() => void onDelete()}
              >
                削除する
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
