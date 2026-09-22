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
} as const;
