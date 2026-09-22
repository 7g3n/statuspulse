import {
  describeCause,
  formatDowntime,
  formatResponseTime,
  formatUptimePercent,
  isStatusStale,
  publicState,
  PUBLIC_STATE_DESCRIPTIONS,
  PUBLIC_STATE_HEADLINES,
  timeBasedUptime,
  type PublicState,
  type PublicStatus,
  type PublicStatusCheck,
} from '@statuspulse/core';
import { useParams } from 'react-router-dom';

import { cn, LoadingBlock } from '@/components/ui';
import { formatDateTime, formatShortDateTime } from '@/lib/format';

import { usePublicStatus } from './api';

/**
 * 公開ステータスページ。
 *
 * 認証の外側にある唯一の画面で、`/status/:slug` で開く。
 * 取得は `public_status(slug)` だけを通り、テーブルには一切触らない
 * （詳細は docs/decisions.md の判断 24）。
 *
 * 画面としての方針:
 *   - 見出しだけで結論が分かること。障害中に開かれる画面で、読ませてはいけない
 *   - 「いつ時点の情報か」を必ず出すこと。古い情報を現在の状態と取り違えさせない
 *   - 自社の内部事情を出さないこと。URL も、エラーの本文も、担当者も出さない
 */

const STATE_STYLES: Record<PublicState, { band: string; dot: string; text: string }> = {
  operational: { band: 'bg-up-100', dot: 'bg-up-500', text: 'text-up-700' },
  outage: { band: 'bg-down-100', dot: 'bg-down-500', text: 'text-down-700' },
  unknown: { band: 'bg-slate-100', dot: 'bg-slate-400', text: 'text-slate-600' },
};

function UptimeTile({
  label,
  downSeconds,
  windowSeconds,
}: {
  label: string;
  downSeconds: number;
  windowSeconds: number;
}) {
  const ratio = timeBasedUptime(downSeconds, windowSeconds);

  return (
    <div className="rounded-lg bg-white px-4 py-3 ring-1 ring-slate-200/70 ring-inset">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="tabular mt-1 text-2xl font-semibold text-slate-900">
        {formatUptimePercent(ratio)}
        {ratio !== null && <span className="text-sm font-normal">%</span>}
      </p>
      <p className="mt-0.5 text-xs text-slate-400">
        {downSeconds <= 0 ? '停止なし' : `停止 ${formatDowntime(downSeconds)}`}
      </p>
    </div>
  );
}

/**
 * 直近のチェックの帯。
 *
 * 管理画面のものと違い、ステータスコードは出さない。
 * 応答時間は出す（速さは利用者の体感そのもので、隠す理由が無い）。
 */
function PublicCheckStrip({ checks }: { checks: PublicStatusCheck[] }) {
  if (checks.length === 0) {
    return <p className="text-sm text-slate-500">まだ記録がありません。</p>;
  }

  return (
    <div>
      <div className="flex items-end gap-[3px]" role="img" aria-label="直近のチェック結果">
        {checks.map((check) => (
          <span
            key={check.checked_at}
            title={`${formatShortDateTime(check.checked_at)} ${
              check.result === 'up'
                ? `正常（${formatResponseTime(check.response_time_ms)}）`
                : '異常'
            }`}
            className={cn(
              'h-8 flex-1 rounded-sm',
              check.result === 'up' ? 'bg-up-500/70' : 'bg-down-500',
            )}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-slate-400">
        <span>{formatShortDateTime(checks[0]?.checked_at ?? null)}</span>
        <span>最新</span>
      </div>
    </div>
  );
}

function IncidentList({ status }: { status: PublicStatus }) {
  if (status.incidents.length === 0) {
    return <p className="text-sm text-slate-500">記録している期間内に障害はありません。</p>;
  }

  return (
    <ul className="divide-y divide-slate-100">
      {status.incidents.map((incident) => (
        <li key={incident.started_at} className="flex flex-wrap items-baseline gap-x-3 py-2.5">
          <span className="tabular text-sm text-slate-900">
            {formatShortDateTime(incident.started_at)}
            <span className="mx-1 text-slate-300">→</span>
            {incident.ended_at === null ? (
              <span className="font-medium text-down-700">継続中</span>
            ) : (
              formatShortDateTime(incident.ended_at)
            )}
          </span>
          <span
            className={cn(
              'tabular rounded px-1.5 py-0.5 text-xs font-medium',
              incident.ended_at === null
                ? 'bg-down-100 text-down-700'
                : 'bg-slate-100 text-slate-600',
            )}
          >
            {formatDowntime(incident.duration_seconds)}
          </span>
          <span className="text-xs text-slate-500">{describeCause(incident.cause, null)}</span>

          {/* 公開が許可されたメモだけが届く（許可されていなければキーごと無い）。 */}
          {incident.postmortem && (
            <p className="mt-1 w-full whitespace-pre-wrap rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-700">
              {incident.postmortem}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function PublicStatusPage() {
  const { slug = '' } = useParams();
  const { data, isPending, error } = usePublicStatus(slug);

  if (isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-50">
        <LoadingBlock />
      </div>
    );
  }

  // 存在しない slug と公開停止中を区別しない。
  // 区別すると「その URL は存在する」ことを教えてしまう。
  if (error || !data) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-4">
        <div className="text-center">
          <p className="text-sm font-medium text-slate-900">ページが見つかりません</p>
          <p className="mt-1 text-sm text-slate-500">
            URL が正しいか確認してください。公開が停止されている場合もあります。
          </p>
        </div>
      </div>
    );
  }

  const state = publicState(data);
  const styles = STATE_STYLES[state];
  const stale = isStatusStale(data);

  return (
    <div className="min-h-dvh bg-slate-50">
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{data.title}</h1>
          {data.description && <p className="mt-1.5 text-sm text-slate-600">{data.description}</p>}
        </header>

        {/* 見出しだけで結論が分かること。障害の最中に読ませてはいけない。 */}
        <div className={cn('mt-6 rounded-lg px-5 py-4', styles.band)}>
          <div className="flex items-center gap-2.5">
            <span className={cn('size-2.5 rounded-full', styles.dot)} />
            <p className={cn('text-base font-semibold', styles.text)}>
              {PUBLIC_STATE_HEADLINES[state]}
            </p>
          </div>
          <p className="mt-1.5 text-sm text-slate-600">{PUBLIC_STATE_DESCRIPTIONS[state]}</p>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <UptimeTile
            label="直近24時間の稼働率"
            downSeconds={data.uptime.day.down_seconds}
            windowSeconds={data.uptime.day.window_seconds}
          />
          <UptimeTile
            label="直近7日間の稼働率"
            downSeconds={data.uptime.week.down_seconds}
            windowSeconds={data.uptime.week.window_seconds}
          />
        </div>

        <section className="mt-6 rounded-lg bg-white px-5 py-5 ring-1 ring-slate-200/70 ring-inset">
          <h2 className="text-sm font-semibold text-slate-900">直近のチェック</h2>
          <div className="mt-3">
            <PublicCheckStrip checks={data.checks} />
          </div>
        </section>

        <section className="mt-4 rounded-lg bg-white px-5 py-5 ring-1 ring-slate-200/70 ring-inset">
          <h2 className="text-sm font-semibold text-slate-900">障害の履歴</h2>
          <div className="mt-2">
            <IncidentList status={data} />
          </div>
        </section>

        {/*
          「いつ時点の情報か」を必ず出す。
          定期処理が止まっていても画面は前の値を映し続けるので、
          鮮度を出さないと古い情報を現在の状態と取り違えられる。
        */}
        <footer className="mt-6 text-xs text-slate-400">
          <p>
            最終確認: {formatDateTime(data.last_checked_at)}
            {stale && <span className="ml-1.5 text-warn-700">（更新が滞っています）</span>}
          </p>
          <p className="mt-0.5">
            この情報は {formatDateTime(data.generated_at)} 時点のものです。 外部から
            {Math.round(data.interval_seconds / 60)}分ごとに確認しています。
          </p>
          <p className="mt-2 text-slate-300">Powered by StatusPulse</p>
        </footer>
      </div>
    </div>
  );
}
