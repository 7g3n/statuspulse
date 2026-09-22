/**
 * ログイン状態の保持。
 *
 * 認証そのものは Supabase Auth が持ち、ここはその状態を React に橋渡しするだけ。
 * 「このユーザーが何を見られるか」はここでは決めない（RLS が決める）。
 * 画面側の分岐は体験のためのもので、防御ではない。
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { dataSource, type SessionUser } from '@/lib/data-source';

type SessionContextValue = {
  user: SessionUser | null;
  /** 最初のセッション確認が終わるまで true。ここで画面を出し分ける。 */
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    // 購読を先に張ってから現在のセッションを読む。
    // 逆順にすると、読んでいる最中に起きた変化を取りこぼす。
    const unsubscribe = dataSource.onAuthStateChange((nextUser) => {
      if (active) setUser(nextUser);
    });

    void dataSource.getSession().then((currentUser) => {
      if (!active) return;
      setUser(currentUser);
      setLoading(false);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      user,
      loading,
      signIn: (email, password) => dataSource.signIn(email, password),
      signUp: (email, password) => dataSource.signUp(email, password),
      signOut: () => dataSource.signOut(),
    }),
    [user, loading],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession は SessionProvider の内側でのみ使えます');
  return context;
}
