import type { MemberRole } from '@statuspulse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { dataSource } from '@/lib/data-source';
import { queryKeys } from '@/lib/query-keys';

export function useMembers(monitorId: string) {
  return useQuery({
    queryKey: queryKeys.members(monitorId),
    queryFn: () => dataSource.loadMembers(monitorId),
  });
}

/**
 * 共有まわりの更新は、メンバー一覧とダッシュボードの両方を無効化する。
 *
 * ダッシュボードまで無効化するのは、`monitor_overview` が自分の役割
 * （`viewer_role`）と公開状態を持っているため。自分を降格させたときに
 * 画面のボタンが変わらないと、押して初めて拒否されることになる。
 */
function useSharingMutation<TArgs>(
  monitorId: string,
  mutationFn: (args: TArgs) => Promise<unknown>,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.members(monitorId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export function useAddMember(monitorId: string) {
  return useSharingMutation(monitorId, ({ email, role }: { email: string; role: MemberRole }) =>
    dataSource.addMember(monitorId, email, role),
  );
}

export function useSetMemberRole(monitorId: string) {
  return useSharingMutation(monitorId, ({ userId, role }: { userId: string; role: MemberRole }) =>
    dataSource.setMemberRole(monitorId, userId, role),
  );
}

export function useRemoveMember(monitorId: string) {
  return useSharingMutation(monitorId, (userId: string) =>
    dataSource.removeMember(monitorId, userId),
  );
}

export function usePublishStatusPage(monitorId: string) {
  return useSharingMutation(
    monitorId,
    ({ title, description }: { title: string; description: string }) =>
      dataSource.publishStatusPage(monitorId, title, description),
  );
}

export function useRotateStatusPageSlug(monitorId: string) {
  return useSharingMutation(monitorId, () => dataSource.rotateStatusPageSlug(monitorId));
}

export function useSetStatusPagePublished(monitorId: string) {
  return useSharingMutation(monitorId, (isPublished: boolean) =>
    dataSource.setStatusPagePublished(monitorId, isPublished),
  );
}
