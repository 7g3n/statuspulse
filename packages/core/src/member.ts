/**
 * 監視対象に対する役割（Phase 3）。
 *
 * DB の member_role enum と一対一。判定の本体は RLS とポリシーで、
 * ここにあるのは**画面の出し分けのため**の写し。
 *
 * この分担は Phase 1 から変えていない。押せないボタンを描かないのは体験のためで、
 * 防御ではない。ここの分岐をすべて消しても、できることは1つも増えない。
 *
 * profiles.role（owner / member）とは別の軸であることに注意。
 * あちらはアカウント全体の役割で、こちらは「この監視対象に対する」役割。
 */

export const MEMBER_ROLES = ['owner', 'editor', 'viewer'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const MEMBER_ROLE_LABELS: Record<MemberRole, string> = {
  owner: '所有者',
  editor: '編集者',
  viewer: '閲覧者',
};

export const MEMBER_ROLE_DESCRIPTIONS: Record<MemberRole, string> = {
  owner: '設定の変更、共有、公開ページの発行、削除',
  editor: '設定の変更まで（削除と共有はできない）',
  viewer: '閲覧のみ',
};

/**
 * 画面から役割を選ぶときの選択肢。
 *
 * owner を含めるのは、所有権を譲る操作が必要になるため
 * （最後の1人を降格させることは DB 側で拒否される）。
 */
export const ASSIGNABLE_MEMBER_ROLES = MEMBER_ROLES;

/** 監視設定を変更できるか。null は「メンバーではない」。 */
export function canEditMonitor(role: MemberRole | null | undefined): boolean {
  return role === 'owner' || role === 'editor';
}

/**
 * 共有設定・公開ページ・削除ができるか。
 *
 * editor に削除を許さないのは、監視対象の削除がチェック履歴と
 * ダウンタイムの記録を巻き添えにするため。設定の変更と同じ重さの操作ではない。
 */
export function canManageMonitor(role: MemberRole | null | undefined): boolean {
  return role === 'owner';
}
