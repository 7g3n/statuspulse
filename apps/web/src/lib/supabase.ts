import type { Database } from '@statuspulse/core';
import { createClient } from '@supabase/supabase-js';

import { isSupabaseConfigured, supabaseConfig } from './env';

/**
 * Supabase クライアント。
 *
 * Database 型を渡すことで、テーブル名・列名・RPC の引数と戻り値がすべて型で守られる。
 * 「列名を間違えたクエリが実行時まで気付かれない」という、この構成で最も起きやすい事故を
 * 型で潰すのが狙い。
 *
 * 未設定時もクライアント自体は作る（App 側でセットアップ案内に切り替える）。
 */
export const supabase = createClient<Database>(
  isSupabaseConfigured ? supabaseConfig.url : 'http://localhost:54421',
  isSupabaseConfigured ? supabaseConfig.anonKey : 'not-configured',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  },
);
