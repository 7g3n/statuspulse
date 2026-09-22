/**
 * TanStack Query のキー。
 *
 * 文字列を呼び出し側で組み立てると、無効化のときに綴りがずれて
 * 「更新したのに一覧が変わらない」が起きる。定義を1か所に集める。
 */
export const queryKeys = {
  dashboard: ['dashboard'] as const,
  monitor: (id: string) => ['monitor', id] as const,
  monitorChecks: (id: string) => ['monitor', id, 'checks'] as const,
  /** 監視対象を絞らない一覧は 'all'。キーの形を揃えて無効化を1か所で書けるようにする。 */
  incidents: (monitorId: string | undefined) => ['incidents', monitorId ?? 'all'] as const,
  members: (monitorId: string) => ['monitor', monitorId, 'members'] as const,
  /** 公開ページ。認証前でも使うのでユーザーに紐づけない。 */
  publicStatus: (slug: string) => ['public-status', slug] as const,
} as const;
