import { useState, type FormEvent } from 'react';

import { Button, Card, Field, Input } from '@/components/ui';
import { isMockMode } from '@/lib/env';

import { useSession } from './session';

/**
 * ログインとアカウント作成。
 *
 * 画面を分けず、1つのフォームでモードを切り替える。
 * 個人〜小規模チームで使うツールなので、アカウントを作る機会は
 * 一人あたり一度しかない。そのために別画面を用意して導線を増やす意味が薄い。
 */
export function LoginPage() {
  const { signIn, signUp } = useSession();

  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState(isMockMode ? 'demo@statuspulse.test' : '');
  const [password, setPassword] = useState(isMockMode ? 'demo-password' : '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      if (mode === 'sign-in') {
        await signIn(email, password);
      } else {
        await signUp(email, password);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'エラーが発生しました');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <p className="text-2xl font-semibold tracking-tight text-slate-900">StatusPulse</p>
          <p className="mt-1 text-sm text-slate-500">自分のサービスの稼働を見張る</p>
        </div>

        <Card className="p-6">
          <form onSubmit={onSubmit} className="space-y-4">
            <Field label="メールアドレス" htmlFor="email">
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>

            <Field
              label="パスワード"
              htmlFor="password"
              hint={mode === 'sign-up' ? '6文字以上' : undefined}
            >
              <Input
                id="password"
                type="password"
                autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
                required
                minLength={6}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>

            {error && <p className="text-sm text-down-700">{error}</p>}

            <Button type="submit" variant="primary" loading={submitting} className="w-full">
              {mode === 'sign-in' ? 'ログイン' : 'アカウントを作成'}
            </Button>
          </form>

          <div className="mt-4 text-center">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
                setError(null);
              }}
            >
              {mode === 'sign-in' ? 'はじめて利用する' : 'ログイン画面に戻る'}
            </Button>
          </div>
        </Card>

        {isMockMode && (
          <p className="mt-4 text-center text-xs text-slate-500">
            モックモードで動作しています。任意の値でログインできます。
          </p>
        )}
      </div>
    </div>
  );
}
