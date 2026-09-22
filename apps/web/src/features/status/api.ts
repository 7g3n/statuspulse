import { useQuery } from '@tanstack/react-query';

import { dataSource } from '@/lib/data-source';
import { queryKeys } from '@/lib/query-keys';

/**
 * 公開ステータスページの内容。
 *
 * 障害の最中に開かれる画面なので、開いたまま置かれることを前提に自動更新する。
 * 間隔をダッシュボードより長め（60秒）にしているのは、この画面が
 * 不特定多数から開かれうるため。人数ぶんの問い合わせが DB に届く。
 */
export const PUBLIC_STATUS_REFETCH_INTERVAL_MS = 60_000;

export function usePublicStatus(slug: string) {
  return useQuery({
    queryKey: queryKeys.publicStatus(slug),
    queryFn: () => dataSource.loadPublicStatus(slug),
    refetchInterval: PUBLIC_STATUS_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    // 見つからない slug は何度試しても見つからない。再試行しない。
    retry: false,
  });
}
