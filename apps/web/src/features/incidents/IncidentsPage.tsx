import { formatDowntime } from '@statuspulse/core';

import { Card, EmptyBlock, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui';

import { IncidentTimeline } from './IncidentTimeline';
import { INCIDENT_LIST_LIMIT, useIncidents } from './api';

/**
 * ダウンタイムの履歴。
 *
 * ダッシュボードが「今どうなっているか」を答えるのに対し、この画面は
 * 「何が起きていたか」を答える。数字（稼働率 99.6%）だけでは
 * 1回の長い障害と細かい失敗の散らばりが区別できないので、期間そのものを並べる。
 */
export function IncidentsPage() {
  const { data, isPending, error, refetch } = useIncidents();

  const incidents = data ?? [];
  const ongoing = incidents.filter((incident) => incident.ended_at === null);
  const totalSeconds = incidents.reduce((sum, incident) => sum + incident.duration_seconds, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="ダウンタイム履歴"
        description="いつ落ちて、いつ復旧したかの記録です。保持している直近7日ぶんのチェックから作られます。"
      />

      {isPending ? (
        <Card>
          <LoadingBlock />
        </Card>
      ) : error ? (
        <Card>
          <ErrorBlock error={error} onRetry={() => void refetch()} />
        </Card>
      ) : incidents.length === 0 ? (
        <Card>
          <EmptyBlock
            title="ダウンタイムの記録はありません"
            description="監視を始めてから、どの対象も異常と判定されていません。"
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Card className="px-4 py-3">
              <p className="text-xs text-slate-500">記録された障害</p>
              <p className="tabular mt-1 text-2xl font-semibold text-slate-900">
                {incidents.length}
                {incidents.length >= INCIDENT_LIST_LIMIT && '+'}
              </p>
              <p className="mt-0.5 text-xs text-slate-400">件</p>
            </Card>

            <Card className="px-4 py-3">
              <p className="text-xs text-slate-500">継続中</p>
              <p
                className={
                  'tabular mt-1 text-2xl font-semibold ' +
                  (ongoing.length > 0 ? 'text-down-700' : 'text-slate-900')
                }
              >
                {ongoing.length}
              </p>
              <p className="mt-0.5 text-xs text-slate-400">件</p>
            </Card>

            <Card className="col-span-2 px-4 py-3 sm:col-span-1">
              <p className="text-xs text-slate-500">停止時間の合計</p>
              <p className="tabular mt-1 text-2xl font-semibold text-slate-900">
                {formatDowntime(totalSeconds)}
              </p>
              {/* 対象をまたいだ合計なので、同じ時間帯に2つ落ちていれば二重に数える。
                  「サービス全体が何分止まったか」ではないことを明記しておく */}
              <p className="mt-0.5 text-xs text-slate-400">全対象の合計（重複あり）</p>
            </Card>
          </div>

          <Card className="px-5 py-5">
            <IncidentTimeline incidents={incidents} />
          </Card>
        </>
      )}
    </div>
  );
}
