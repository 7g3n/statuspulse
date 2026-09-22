import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from '@/components/AppShell';
import { LoadingBlock } from '@/components/ui';
import { LoginPage } from '@/features/auth/LoginPage';
import { SessionProvider, useSession } from '@/features/auth/session';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { IncidentsPage } from '@/features/incidents/IncidentsPage';
import { MonitorDetailPage } from '@/features/monitors/MonitorDetailPage';
import { PublicStatusPage } from '@/features/status/PublicStatusPage';
import { isMockMode, isSupabaseConfigured } from '@/lib/env';

import { SetupNotice } from './SetupNotice';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 監視の画面では、古い値を再利用するより取り直す方が望ましい。
      // ただし画面遷移のたびに毎回走らせる必要はないので、チェック間隔の最短より短い値にする。
      staleTime: 15_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

/**
 * 認証の内側であることを保証する。
 *
 * Phase 3 で公開ステータスページ（`/status/:slug`）が増え、
 * 「認証の内側だけで動くアプリ」ではなくなった。
 * どの画面が認証を要求するかをルート定義の側で見えるようにするため、
 * 画面全体を包むのではなくルートごとに包む形にしてある。
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useSession();

  // セッションの確認中にログイン画面を出すと、リロードのたびに一瞬ログイン画面が見える。
  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <LoadingBlock label="読み込んでいます" />
      </div>
    );
  }

  if (!user) return <LoginPage />;

  return <AppShell>{children}</AppShell>;
}

export function App() {
  // 設定が無い状態で起動したときに、白い画面ではなくセットアップ手順を出す。
  if (!isSupabaseConfigured && !isMockMode) return <SetupNotice />;

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionProvider>
          <Routes>
            {/* 認証の外側。anon キーのまま public_status() だけを呼ぶ。 */}
            <Route path="/status/:slug" element={<PublicStatusPage />} />

            <Route
              path="/"
              element={
                <RequireAuth>
                  <DashboardPage />
                </RequireAuth>
              }
            />
            <Route
              path="/incidents"
              element={
                <RequireAuth>
                  <IncidentsPage />
                </RequireAuth>
              }
            />
            <Route
              path="/monitors/:monitorId"
              element={
                <RequireAuth>
                  <MonitorDetailPage />
                </RequireAuth>
              }
            />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
