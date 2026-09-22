/**
 * 状態を表す小さな表示部品。
 *
 * 共通する方針: **色だけで意味を伝えない。**
 * ステータスには必ず文字を添え、チェック履歴の帯には title 属性で内容を持たせる。
 * 赤と緑の区別が付きにくい人にとって、色分けだけの監視画面は読めない画面になる。
 */
import {
  CHECK_ERROR_KIND_LABELS,
  formatUptimePercent,
  gradeUptime,
  MONITOR_STATUS_LABELS,
  type MonitorStatus,
  type RecentCheckRow,
  type UptimeGrade,
} from '@statuspulse/core';

import { formatShortDateTime } from '@/lib/format';

import { cn } from './ui';

/* -------------------------------------------------------------------------- */
/* 稼働状態                                                                    */
/* -------------------------------------------------------------------------- */

const STATUS_STYLES: Record<MonitorStatus, string> = {
  up: 'bg-up-100 text-up-700 ring-up-500/30',
  down: 'bg-down-100 text-down-700 ring-down-500/30',
  unknown: 'bg-slate-100 text-slate-600 ring-slate-400/30',
};

const STATUS_DOT: Record<MonitorStatus, string> = {
  up: 'bg-up-500',
  down: 'bg-down-500',
  unknown: 'bg-slate-400',
};

export function StatusBadge({
  status,
  isEnabled = true,
}: {
  status: MonitorStatus;
  isEnabled?: boolean;
}) {
  // 無効化された対象の状態は「最後に見たときの状態」でしかない。
  // それを現在の状態として緑や赤で出すと、監視されているように見えてしまう。
  if (!isEnabled) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500 ring-1 ring-inset ring-slate-400/30">
        <span className="size-1.5 rounded-full bg-slate-400" />
        停止中
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset',
        STATUS_STYLES[status],
      )}
    >
      <span className={cn('size-1.5 rounded-full', STATUS_DOT[status])} />
      {MONITOR_STATUS_LABELS[status]}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* 稼働率                                                                      */
/* -------------------------------------------------------------------------- */

const GRADE_TEXT: Record<UptimeGrade, string> = {
  healthy: 'text-slate-900',
  degraded: 'text-warn-700',
  critical: 'text-down-700',
  unknown: 'text-slate-400',
};

/**
 * 稼働率の表示。
 *
 * 数字そのものより「何回中何回か」の方が判断に効く場面が多い
 * （12回中12回の 100% と、2016回中2016回の 100% は重みが違う）ので、
 * 分母を必ず併記する。
 */
export function UptimeValue({
  ratio,
  total,
  unreliable = false,
}: {
  ratio: number | null;
  total: number;
  unreliable?: boolean;
}) {
  const grade = gradeUptime(ratio);

  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={cn('tabular text-sm font-semibold', GRADE_TEXT[grade])}>
        {formatUptimePercent(ratio)}
        {ratio !== null && <span className="text-xs font-normal">%</span>}
      </span>
      <span className="tabular text-xs text-slate-400">
        {total === 0 ? '未計測' : `/ ${total}回`}
      </span>
      {unreliable && (
        <span
          className="text-xs text-warn-700"
          title="チェックの実行回数が想定を下回っています。定期処理が止まっていた時間は稼働率の分母から抜けるため、実際より良い数字が出ている可能性があります。"
        >
          ⚠
        </span>
      )}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* チェック履歴の帯                                                            */
/* -------------------------------------------------------------------------- */

function checkTitle(check: RecentCheckRow): string {
  const at = formatShortDateTime(check.checked_at);

  if (check.result === 'up') {
    const time = check.response_time_ms === null ? '' : ` / ${check.response_time_ms}ms`;
    return `${at} 正常（HTTP ${check.status_code ?? '—'}${time}）`;
  }

  const kind = check.error_kind ? CHECK_ERROR_KIND_LABELS[check.error_kind] : '';
  return `${at} 異常（${kind}${check.status_code === null ? '' : ` / HTTP ${check.status_code}`}）`;
}

/**
 * 直近のチェックを左から右へ時系列で並べた帯。
 *
 * 稼働率の数字だけでは「いつ落ちたか」が分からない。
 * 99.5% という値は、1回の長い障害でも、細かい失敗の散らばりでも同じになる。
 * 形が見えると、その2つを一目で区別できる。
 *
 * 件数が足りない場合は左側を空白で埋める。詰めて描くと、
 * 登録直後の対象が「ずっと監視されてきた」ように見えてしまう。
 */
export function CheckStrip({
  checks,
  capacity,
  isEnabled = true,
}: {
  checks: RecentCheckRow[];
  capacity: number;
  isEnabled?: boolean;
}) {
  const padding = Math.max(0, capacity - checks.length);

  return (
    <div
      // 停止中の対象の帯は「止める前の記録」でしかない。
      // 有効な対象と同じ濃さで描くと、今も緑が積み上がっているように見えてしまう。
      className={cn('flex items-end gap-[2px]', !isEnabled && 'opacity-35')}
      role="img"
      aria-label={isEnabled ? '直近のチェック結果' : '停止前の直近のチェック結果'}
    >
      {Array.from({ length: padding }, (_, index) => (
        <span key={`pad-${index}`} className="h-6 w-[5px] rounded-sm bg-slate-100" />
      ))}
      {checks.map((check) => (
        <span
          key={check.checked_at}
          title={checkTitle(check)}
          className={cn(
            'h-6 w-[5px] rounded-sm',
            check.result === 'up' ? 'bg-up-500/70' : 'bg-down-500',
          )}
        />
      ))}
    </div>
  );
}
