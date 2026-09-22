import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from '@/components/AppShell';
import { LoadingBlock } from '@/components/ui';
import { LoginPage } from '@/features/auth/LoginPage';
import { SessionProvider, useSession } from '@/features/auth/session';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { MonitorDetailPage } from '@/features/monitors/MonitorDetailPage';
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

function AuthenticatedApp() {
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

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/monitors/:monitorId" element={<MonitorDetailPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}

export function App() {
  // 設定が無い状態で起動したときに、白い画面ではなくセットアップ手順を出す。
  if (!isSupabaseConfigured && !isMockMode) return <SetupNotice />;

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionProvider>
          <AuthenticatedApp />
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
