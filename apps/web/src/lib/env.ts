/**
 * 環境変数の読み取り。
 *
 * Vite は VITE_ 接頭辞の変数だけをバンドルに埋め込む。
 * ブラウザに出るのは anon キーのみで、これは RLS 前提で公開されることを想定した鍵。
 * service_role キーは Worker 側の secret としてのみ扱い、この層には絶対に持ち込まない。
 *
 * 未設定のときに例外で落とさないのは、セットアップ手順を画面で案内するため。
 * 初見の人が「白い画面とコンソールのエラー」に出会うのを避ける。
 */

const url = import.meta.env.VITE_SUPABASE_URL ?? '';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

export const supabaseConfig = { url, anonKey } as const;

export const isSupabaseConfigured = url.length > 0 && anonKey.length > 0;

/**
 * モックモード。
 *
 * Supabase を立てずに、生成したダミーデータで画面を動かす。
 * `pnpm dev:mock`（vite --mode mock）で有効になる。
 *
 * 何のために用意しているか:
 *   - デモとスクリーンショット。DB と Worker を動かさずに、動く画面を見せられる
 *   - 画面の実装時に、7日ぶんの履歴や「今まさに落ちている対象」を自由に作れる
 *
 * 差し替えの境界を lib/data-source.ts の1か所に閉じてあるので、
 * 画面のコードはどちらのモードで動いているかを知らない。
 */
export const isMockMode = import.meta.env.VITE_USE_MOCK === 'true';
