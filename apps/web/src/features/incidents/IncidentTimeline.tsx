import {
  describeCause,
  formatDowntime,
  type IncidentOverviewRow,
  type NotificationRow,
} from '@statuspulse/core';
import { Link } from 'react-router-dom';

import { cn } from '@/components/ui';
import { formatShortDateTime } from '@/lib/format';

import { PostmortemEditor } from './PostmortemEditor';

/**
 * ダウンタイムのタイムライン。
 *
 * 日付でまとめて縦に並べる。障害は「いつ」が分かって初めて原因の心当たりと結びつく
 * （デプロイした日、設定を変えた日）ので、時刻を最も読みやすい位置に置いている。
 *
 * 一覧（全対象）と監視対象の詳細の両方で使うため、対象名を出すかを切り替えられる。
 */

const NOTIFICATION_LABELS: Record<NotificationRow['status'], string> = {
  pending: '送信中',
  sent: '通知済み',
  failed: '通知失敗',
  skipped: '未送信',
};

const NOTIFICATION_STYLES: Record<NotificationRow['status'], string> = {
  pending: 'text-slate-500',
  sent: 'text-slate-500',
  failed: 'text-down-700',
  skipped: 'text-slate-400',
};

/**
 * 通知の状態を出すのは、通知が来なかったときに
 * 「送っていない」のか「送ったが届いていない」のかを切り分けられるようにするため。
 * ここが空欄なら、そもそも通知の対象になっていない。
 */
function NotificationTag({
  label,
  status,
}: {
  label: string;
  status: NotificationRow['status'] | null;
}) {
  if (status === null) return null;

  const suffix = NOTIFICATION_LABELS[status];
  return (
    <span className={cn('text-xs', NOTIFICATION_STYLES[status])}>
      {label}
      {suffix}
      {status === 'skipped' && (
        <span title="Slack Webhook が未設定のため送信していません">（Webhook 未設定）</span>
      )}
    </span>
  );
}

/** JST の 'YYYY年M月D日'。日付の区切りは日本時間で入れる。 */
const DATE_LABEL = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
});

function groupByDate(incidents: readonly IncidentOverviewRow[]) {
  const groups = new Map<string, IncidentOverviewRow[]>();

  for (const incident of incidents) {
    const label = DATE_LABEL.format(new Date(incident.started_at));
    const bucket = groups.get(label);
    if (bucket) bucket.push(incident);
    else groups.set(label, [incident]);
  }

  return [...groups.entries()];
}

function IncidentItem({
  incident,
  showMonitor,
  canEdit,
}: {
  incident: IncidentOverviewRow;
  showMonitor: boolean;
  canEdit: boolean;
}) {
  const ongoing = incident.ended_at === null;

  return (
    <li className="relative pl-6">
      {/* 縦線と点。継続中は塗りつぶし、復旧済みは輪郭だけにして、一覧の中で区別できるようにする */}
      <span
        className={cn(
          'absolute left-0 top-1.5 size-2.5 rounded-full ring-2 ring-white',
          ongoing ? 'bg-down-500' : 'border-2 border-slate-300 bg-white',
        )}
      />

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="tabular text-sm text-slate-900">
          {formatShortDateTime(incident.started_at)}
          <span className="mx-1 text-slate-300">→</span>
          {ongoing ? (
            <span className="font-medium text-down-700">継続中</span>
          ) : (
            formatShortDateTime(incident.ended_at)
          )}
        </span>

        <span
          className={cn(
            'tabular rounded px-1.5 py-0.5 text-xs font-medium',
            ongoing ? 'bg-down-100 text-down-700' : 'bg-slate-100 text-slate-600',
          )}
        >
          {formatDowntime(incident.duration_seconds)}
        </span>

        {showMonitor && (
          <Link
            to={`/monitors/${incident.monitor_id}`}
            className="text-sm font-medium text-slate-700 hover:text-brand-700 hover:underline"
          >
            {incident.monitor_name}
          </Link>
        )}
      </div>

      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-xs text-slate-500">
        <span className="text-down-700">{describeCause(incident.cause, incident.status_code)}</span>
        <span>失敗 {incident.failure_count} 回</span>
        <NotificationTag label="ダウン " status={incident.down_notification_status} />
        <NotificationTag label="復旧 " status={incident.recovered_notification_status} />
      </div>

      {incident.error_message && (
        <p className="mt-1 truncate text-xs text-slate-400" title={incident.error_message}>
          {incident.error_message}
        </p>
      )}

      <PostmortemEditor incident={incident} canEdit={canEdit} />
    </li>
  );
}

export function IncidentTimeline({
  incidents,
  showMonitor = true,
  canEdit = false,
}: {
  incidents: readonly IncidentOverviewRow[];
  showMonitor?: boolean;
  /** ポストモーテムを書けるか（editor 以上）。防御は RLS 側にある。 */
  canEdit?: boolean;
}) {
  return (
    <div className="space-y-6">
      {groupByDate(incidents).map(([date, items]) => (
        <div key={date}>
          <p className="text-xs font-medium text-slate-500">{date}</p>
          <ul className="mt-2.5 space-y-4 border-l border-slate-200 pl-1.5">
            {items.map((incident) => (
              <IncidentItem
                key={incident.id}
                incident={incident}
                showMonitor={showMonitor}
                canEdit={canEdit}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
