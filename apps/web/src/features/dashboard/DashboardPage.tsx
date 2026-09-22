import {
  canEditMonitor,
  CHECK_ERROR_KIND_LABELS,
  CHECK_INTERVAL_LABELS,
  MEMBER_ROLE_LABELS,
  checkCoverage,
  displayUrl,
  formatResponseTime,
  isCheckInterval,
  isCoverageReliable,
  observedWindowSeconds,
  timeBasedUptime,
  WINDOW_SECONDS,
  type MonitorOverviewRow,
} from '@statuspulse/core';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { CheckStrip, StatusBadge, UptimeValue } from '@/components/badges';
import { Button, Card, EmptyBlock, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui';
import { MonitorFormDialog } from '@/features/monitors/MonitorFormDialog';
import { RECENT_CHECK_COUNT } from '@/lib/data-source';
import { formatDuration, formatRelativeTime } from '@/lib/format';

import { useDashboard } from './api';

/**
 * 稼働率の集計期間は、監視対象を登録してからの時間で頭打ちにする。
 *
 * 登録して1時間の対象に「24時間で12回しかチェックされていない」と警告を出しても、
 * それは取りこぼしではなく、単にまだ24時間経っていないだけ。
 */
function coverageOf(monitor: MonitorOverviewRow, windowSeconds: number, actual: number) {
  const ageSeconds = (Date.now() - Date.parse(monitor.created_at)) / 1000;
  return checkCoverage(actual, monitor.interval_seconds, Math.min(windowSeconds, ageSeconds));
}

/**
 * 稼働率に「取りこぼしの疑い」を添えるか。
 *
 * 期待回数が数回しかない段階では、1回のずれで簡単に9割を下回る。
 * 警告が鳴りやすすぎると読まれなくなるので、ある程度の回数が溜まってから出す。
 */
function shouldWarnCoverage(monitor: MonitorOverviewRow, actual: number): boolean {
  if (!monitor.is_enabled) return false;
  const coverage = coverageOf(monitor, WINDOW_SECONDS.day, actual);
  if (coverage.expected < 10) return false;
  return !isCoverageReliable(coverage);
}

function StatTile({
  label,
  value,
  tone = 'default',
  hint,
}: {
  label: string;
  value: string;
  tone?: 'default' | 'alert';
  hint?: string;
}) {
  return (
    <Card className="px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p
        className={
          'tabular mt-1 text-2xl font-semibold ' +
          (tone === 'alert' ? 'text-down-700' : 'text-slate-900')
        }
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
    </Card>
  );
}

function MonitorRow({
  monitor,
  recentChecks,
  onEdit,
}: {
  monitor: MonitorOverviewRow;
  recentChecks: Parameters<typeof CheckStrip>[0]['checks'];
  onEdit: () => void;
}) {
  // 稼働率は時間ベース（停止していた時間 ÷ 監視できていた期間）。
  // 期間は監視対象の年齢で頭打ちにする（登録直後の対象を24時間で割らない）。
  const ratio24h = timeBasedUptime(
    monitor.down_seconds_24h,
    observedWindowSeconds(monitor.created_at, WINDOW_SECONDS.day),
  );
  const ratio7d = timeBasedUptime(
    monitor.down_seconds_7d,
    observedWindowSeconds(monitor.created_at, WINDOW_SECONDS.week),
  );
  const warn24h = shouldWarnCoverage(monitor, monitor.checks_24h);

  const interval = isCheckInterval(monitor.interval_seconds)
    ? CHECK_INTERVAL_LABELS[monitor.interval_seconds]
    : `${monitor.interval_seconds}秒`;

  return (
    <tr className="border-t border-slate-100 align-middle hover:bg-slate-50/70">
      <td className="py-3 pl-4 pr-3">
        <StatusBadge status={monitor.current_status} isEnabled={monitor.is_enabled} />
      </td>

      <td className="px-3 py-3">
        <Link
          to={`/monitors/${monitor.id}`}
          className="text-sm font-medium text-slate-900 hover:text-brand-700 hover:underline"
        >
          {monitor.name}
        </Link>
        <p className="mt-0.5 truncate text-xs text-slate-500" title={monitor.url}>
          {monitor.method} {displayUrl(monitor.url)}
          {monitor.member_count > 1 && (
            <span className="ml-1.5 text-slate-400">· {monitor.member_count}人で共有</span>
          )}
          {monitor.status_page_published && (
            <span className="ml-1.5 text-brand-700" title="公開ステータスページを発行しています">
              · 公開中
            </span>
          )}
        </p>

        {/* 落ちている対象は、理由をその場に出す。詳細を開かないと分からないのでは遅い。 */}
        {monitor.is_enabled && monitor.current_status === 'down' && (
          <p className="mt-1 text-xs text-down-700">
            {monitor.last_error_kind ? CHECK_ERROR_KIND_LABELS[monitor.last_error_kind] : '異常'}
            {monitor.status_changed_at && ` / ${formatDuration(monitor.status_changed_at)}継続`}
          </p>
        )}
      </td>

      <td className="hidden px-3 py-3 lg:table-cell">
        <CheckStrip
          checks={recentChecks}
          capacity={RECENT_CHECK_COUNT}
          isEnabled={monitor.is_enabled}
        />
        <p className="mt-1 text-[11px] text-slate-400">
          {monitor.is_enabled ? '直近' : '停止前の直近'}
          {RECENT_CHECK_COUNT}回（{interval}ごと）
        </p>
      </td>

      <td className="px-3 py-3 text-right">
        <UptimeValue ratio={ratio24h} downSeconds={monitor.down_seconds_24h} unreliable={warn24h} />
      </td>

      <td className="hidden px-3 py-3 text-right sm:table-cell">
        <UptimeValue ratio={ratio7d} downSeconds={monitor.down_seconds_7d} />
      </td>

      <td className="tabular hidden whitespace-nowrap px-3 py-3 text-right text-sm text-slate-600 md:table-cell">
        {formatResponseTime(monitor.avg_response_time_ms)}
      </td>

      <td
        className="hidden whitespace-nowrap px-3 py-3 text-right text-xs text-slate-500 md:table-cell"
        title={monitor.last_checked_at ?? undefined}
      >
        {monitor.is_enabled ? formatRelativeTime(monitor.last_checked_at) : '—'}
      </td>

      <td className="whitespace-nowrap py-3 pl-3 pr-4 text-right">
        {canEditMonitor(monitor.viewer_role) ? (
          <Button size="sm" variant="ghost" onClick={onEdit}>
            編集
          </Button>
        ) : (
          // 押せないボタンを描くより、なぜ操作できないのかを出す方が分かる。
          <span className="text-xs text-slate-400">
            {monitor.viewer_role ? MEMBER_ROLE_LABELS[monitor.viewer_role] : '—'}
          </span>
        )}
      </td>
    </tr>
  );
}

export function DashboardPage() {
  const { data, isPending, error, refetch } = useDashboard();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<MonitorOverviewRow | undefined>(undefined);

  function openNew() {
    setEditing(undefined);
    setDialogOpen(true);
  }

  function openEdit(monitor: MonitorOverviewRow) {
    setEditing(monitor);
    setDialogOpen(true);
  }

  const monitors = data?.monitors ?? [];
  const enabled = monitors.filter((monitor) => monitor.is_enabled);
  const down = enabled.filter((monitor) => monitor.current_status === 'down');
  const paused = monitors.filter((monitor) => !monitor.is_enabled);

  // 最終チェックは全体の中で最も新しいものを出す。これが古いままなら、
  // 個々の対象の状態ではなく定期処理そのものが止まっている。
  const lastCheckedAt = enabled
    .map((monitor) => monitor.last_checked_at)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1);

  return (
    <div className="space-y-6">
      <PageHeader
        title="ダッシュボード"
        description="登録した URL の死活を定期的に確認し、稼働率を記録します。"
        actions={
          <Button variant="primary" onClick={openNew}>
            監視対象を追加
          </Button>
        }
      />

      {isPending ? (
        <Card>
          <LoadingBlock />
        </Card>
      ) : error ? (
        <Card>
          <ErrorBlock error={error} onRetry={() => void refetch()} />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="監視中" value={`${enabled.length}`} hint="件" />
            <StatTile
              label="異常"
              value={`${down.length}`}
              tone={down.length > 0 ? 'alert' : 'default'}
              hint="件"
            />
            <StatTile label="停止中" value={`${paused.length}`} hint="件" />
            <StatTile
              label="最終チェック"
              value={formatRelativeTime(lastCheckedAt ?? null)}
              hint="いちばん新しい記録"
            />
          </div>

          <Card className="overflow-hidden">
            {monitors.length === 0 ? (
              <EmptyBlock
                title="監視対象がまだありません"
                description="監視したいサイトや API の URL を登録すると、設定した間隔でチェックを始めます。"
                action={
                  <Button variant="primary" onClick={openNew}>
                    監視対象を追加
                  </Button>
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px]">
                  <thead>
                    <tr className="whitespace-nowrap text-xs text-slate-500">
                      <th className="py-2.5 pl-4 pr-3 text-left font-medium">状態</th>
                      <th className="px-3 py-2.5 text-left font-medium">監視対象</th>
                      <th className="hidden px-3 py-2.5 text-left font-medium lg:table-cell">
                        直近のチェック
                      </th>
                      <th className="px-3 py-2.5 text-right font-medium">24時間</th>
                      <th className="hidden px-3 py-2.5 text-right font-medium sm:table-cell">
                        7日間
                      </th>
                      <th className="hidden px-3 py-2.5 text-right font-medium md:table-cell">
                        平均応答
                      </th>
                      <th className="hidden px-3 py-2.5 text-right font-medium md:table-cell">
                        最終チェック
                      </th>
                      <th className="py-2.5 pl-3 pr-4" />
                    </tr>
                  </thead>
                  <tbody>
                    {monitors.map((monitor) => (
                      <MonitorRow
                        key={monitor.id}
                        monitor={monitor}
                        recentChecks={data?.recentChecks[monitor.id] ?? []}
                        onEdit={() => openEdit(monitor)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      <MonitorFormDialog open={dialogOpen} monitor={editing} onClose={() => setDialogOpen(false)} />
    </div>
  );
}
