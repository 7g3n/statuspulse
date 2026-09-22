import { useQuery } from '@tanstack/react-query';

import { dataSource } from '@/lib/data-source';
import { queryKeys } from '@/lib/query-keys';

/**
 * ダッシュボードのデータ。
 *
 * 自動更新を入れているのは、監視ツールが「開きっぱなしにする画面」だから。
 * 手動で再読み込みしないと更新されない監視画面は、見ている間ずっと過去の状態を映し続ける。
 *
 * 30秒という間隔は、最短のチェック間隔（1分）の半分。
 * これより短くしても新しい結果は生まれず、DB への問い合わせが増えるだけになる。
 */
export const DASHBOARD_REFETCH_INTERVAL_MS = 30_000;

export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: () => dataSource.loadDashboard(),
    refetchInterval: DASHBOARD_REFETCH_INTERVAL_MS,
    // タブを見ていない間は問い合わせない。裏で開いたままのタブが
    // 一晩中ポーリングし続ける必要はない。
    refetchIntervalInBackground: false,
  });
}
