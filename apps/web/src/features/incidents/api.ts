import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { dataSource } from '@/lib/data-source';
import { queryKeys } from '@/lib/query-keys';

import { DASHBOARD_REFETCH_INTERVAL_MS } from '../dashboard/api';

/**
 * 一覧に出すインシデントの件数。
 *
 * 7日ぶんの履歴を持つ設計なので、まともに運用していればこの数には届かない。
 * 届くとしたら「何かがおかしい」状態なので、そのときは古いものが切れてよい。
 */
export const INCIDENT_LIST_LIMIT = 50;

/** 監視対象を渡すとその対象だけ。省くと全対象ぶん。 */
export function useIncidents(monitorId?: string) {
  return useQuery({
    queryKey: queryKeys.incidents(monitorId),
    queryFn: () => dataSource.loadIncidents({ monitorId, limit: INCIDENT_LIST_LIMIT }),
    // 継続中のインシデントは「今どれだけ続いているか」が変わり続けるので、
    // ダッシュボードと同じ間隔で取り直す。
    refetchInterval: DASHBOARD_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}

/**
 * ポストモーテムの保存（Phase 4）。
 *
 * 一覧のキーを絞らずまとめて無効化する。同じ障害が「全対象の履歴」と
 * 「その対象の履歴」の2つのキャッシュに載っているので、片方だけ更新すると
 * 画面を移動したときに古い本文が出る。
 */
export function useSetIncidentPostmortem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      incidentId,
      text,
      isPublic,
    }: {
      incidentId: string;
      text: string;
      isPublic: boolean;
    }) => dataSource.setIncidentPostmortem(incidentId, text, isPublic),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['incidents'] }),
  });
}
