import { Card } from '@/components/ui';

/**
 * Supabase が未設定のときに出す案内。
 *
 * 例外で落として「白い画面とコンソールのエラー」にしないのは、
 * リポジトリを clone した人が最初に出会う画面がこれになるため。
 * ここで手順が読めれば、README を探しに戻る必要がない。
 */
export function SetupNotice() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-10">
      <Card className="w-full max-w-xl p-6">
        <h1 className="text-lg font-semibold text-slate-900">セットアップが必要です</h1>
        <p className="mt-2 text-sm text-slate-600">
          Supabase の接続情報が設定されていません。次のどちらかを行ってください。
        </p>

        <div className="mt-5 space-y-5 text-sm">
          <div>
            <p className="font-medium text-slate-900">1. Supabase を立てる</p>
            <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 px-3 py-2.5 text-xs text-slate-100">
              {`pnpm db:start   # ローカル Supabase を起動
pnpm db:reset   # マイグレーション適用 + シード投入`}
            </pre>
            <p className="mt-2 text-slate-600">
              出力された API URL と anon key を <code className="text-xs">apps/web/.env</code>{' '}
              に書きます。
            </p>
            <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 px-3 py-2.5 text-xs text-slate-100">
              {`VITE_SUPABASE_URL=http://127.0.0.1:54421
VITE_SUPABASE_ANON_KEY=<anon key>`}
            </pre>
          </div>

          <div>
            <p className="font-medium text-slate-900">2. Supabase を立てずに画面だけ見る</p>
            <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 px-3 py-2.5 text-xs text-slate-100">
              pnpm dev:mock
            </pre>
            <p className="mt-2 text-slate-600">
              生成したダミーデータで動作します。実際の監視は行いません。
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
