import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';

import { useSession } from '@/features/auth/session';
import { isMockMode } from '@/lib/env';

import { Button, cn } from './ui';

/**
 * 画面の外枠。
 *
 * Phase 2 で履歴の画面が増えたので、横並びのナビゲーションを足した。
 * サイドバーは置かない。項目が2つのために画面幅を常時削る理由がない。
 */

const NAV_ITEMS = [
  { to: '/', label: 'ダッシュボード', end: true },
  { to: '/incidents', label: 'ダウンタイム履歴', end: false },
] as const;
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

          <nav className="ml-6 mr-auto flex items-center gap-1">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'rounded-md px-2.5 py-1.5 text-sm transition',
                    isActive
                      ? 'bg-slate-100 font-medium text-slate-900'
                      : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

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
