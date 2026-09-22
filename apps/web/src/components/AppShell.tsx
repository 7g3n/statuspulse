import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useSession } from '@/features/auth/session';
import { isMockMode } from '@/lib/env';

import { Button } from './ui';

/**
 * 画面の外枠。
 *
 * Phase 1 の画面はダッシュボードと監視対象の詳細だけなので、サイドバーは置かない。
 * 項目が2つしかないナビゲーションは、場所を取るだけで案内にならない。
 * 画面が増える Phase 2 以降で必要になったら足す。
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { user, signOut } = useSession();

  return (
    <div className="min-h-dvh bg-slate-50">
      {isMockMode && (
        <div className="bg-warn-100 px-4 py-1.5 text-center text-xs text-warn-700">
          モックモードで動作しています。表示しているのは生成したダミーデータで、実際の監視は行っていません。
        </div>
      )}

      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-500 opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-brand-600" />
            </span>
            <span className="text-sm font-semibold tracking-tight text-slate-900">StatusPulse</span>
          </Link>

          <div className="flex items-center gap-3">
            {user && <span className="hidden text-xs text-slate-500 sm:inline">{user.email}</span>}
            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              ログアウト
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
