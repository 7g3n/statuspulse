import type { MonitorFormValues } from '@statuspulse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { dataSource } from '@/lib/data-source';
import { queryKeys } from '@/lib/query-keys';

/** 詳細画面に出すチェック履歴の件数。 */
export const MONITOR_CHECK_HISTORY_LIMIT = 100;

export function useMonitorChecks(monitorId: string) {
  return useQuery({
    queryKey: queryKeys.monitorChecks(monitorId),
    queryFn: () => dataSource.loadMonitorChecks(monitorId, MONITOR_CHECK_HISTORY_LIMIT),
  });
}

/**
 * 監視対象の作成・更新・削除。
 *
 * どれも成功したらダッシュボードを無効化する。稼働率と状態は
 * 監視対象の設定から導かれる値なので、設定が変われば一覧も作り直す必要がある。
 */
export function useCreateMonitor() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (values: MonitorFormValues) => dataSource.createMonitor(values),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
  });
}

export function useUpdateMonitor() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, values }: { id: string; values: MonitorFormValues }) =>
      dataSource.updateMonitor(id, values),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
      void queryClient.invalidateQueries({ queryKey: queryKeys.monitor(variables.id) });
    },
  });
}

export function useDeleteMonitor() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => dataSource.deleteMonitor(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
  });
}
