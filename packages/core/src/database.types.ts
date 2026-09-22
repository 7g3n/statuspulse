/**
 * Supabase のスキーマに対応する型。
 *
 * `supabase gen types typescript` が出力するのと同じ形（Row / Insert / Update /
 * Relationships / Enums / Functions）を手書きで維持している。
 *
 * 手書きにしている理由:
 *   ローカル Supabase（Docker）を起動していない環境でも型チェックとテストが通るようにするため。
 *   CI で DB を立てずに検証できる。
 *
 * 運用:
 *   スキーマ変更時は `pnpm db:types` で再生成する。生成物と同じ形を保っているので、
 *   再生成しても利用側のコードは変わらない。
 *
 * checks の Insert を空にしてあるのは意図的で、直接 INSERT する経路を型の段階で塞いでいる。
 * 観測ログは record_check() 経由でのみ作られる（DB 側でも RLS と GRANT で塞いである）。
 */

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          display_name: string;
          role: Database['public']['Enums']['user_role'];
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          display_name?: string;
          role?: Database['public']['Enums']['user_role'];
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          display_name?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'profiles_id_fkey';
            columns: ['id'];
            isOneToOne: true;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };

      monitors: {
        Row: {
          id: string;
          owner_id: string;
          name: string;
          url: string;
          method: Database['public']['Enums']['http_method'];
          expected_status_code: number | null;
          interval_seconds: number;
          timeout_ms: number;
          is_enabled: boolean;
          current_status: Database['public']['Enums']['monitor_status'];
          consecutive_failures: number;
          failure_threshold: number;
          last_checked_at: string | null;
          status_changed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          owner_id: string;
          name: string;
          url: string;
          method?: Database['public']['Enums']['http_method'];
          expected_status_code?: number | null;
          interval_seconds?: number;
          timeout_ms?: number;
          is_enabled?: boolean;
          failure_threshold?: number;
          created_at?: string;
        };
        /**
         * 判定のキャッシュ（current_status / consecutive_failures / last_checked_at /
         * status_changed_at）は含めない。これらは record_check() が責任を持つ列で、
         * DB 側でも列単位の GRANT により authenticated からは UPDATE できない。
         */
        Update: {
          name?: string;
          url?: string;
          method?: Database['public']['Enums']['http_method'];
          expected_status_code?: number | null;
          interval_seconds?: number;
          timeout_ms?: number;
          is_enabled?: boolean;
          failure_threshold?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'monitors_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };

      checks: {
        Row: {
          id: number;
          monitor_id: string;
          checked_at: string;
          result: Database['public']['Enums']['check_result'];
          status_code: number | null;
          response_time_ms: number | null;
          error_kind: Database['public']['Enums']['check_error_kind'] | null;
          error_message: string | null;
        };
        /** 直接 INSERT する経路は無い（record_check() のみ）。 */
        Insert: Record<string, never>;
        /** 観測ログは追記専用。書き換える経路は無い。 */
        Update: Record<string, never>;
        Relationships: [
          {
            foreignKeyName: 'checks_monitor_id_fkey';
            columns: ['monitor_id'];
            isOneToOne: false;
            referencedRelation: 'monitors';
            referencedColumns: ['id'];
          },
        ];
      };
    };

    Views: {
      monitor_overview: {
        Row: {
          id: string;
          owner_id: string;
          name: string;
          url: string;
          method: Database['public']['Enums']['http_method'];
          expected_status_code: number | null;
          interval_seconds: number;
          timeout_ms: number;
          is_enabled: boolean;
          current_status: Database['public']['Enums']['monitor_status'];
          consecutive_failures: number;
          failure_threshold: number;
          last_checked_at: string | null;
          status_changed_at: string | null;
          created_at: string;
          updated_at: string;
          checks_24h: number;
          up_24h: number;
          checks_7d: number;
          up_7d: number;
          avg_response_time_ms: number | null;
          last_status_code: number | null;
          last_response_time_ms: number | null;
          last_error_kind: Database['public']['Enums']['check_error_kind'] | null;
          last_error_message: string | null;
        };
        Relationships: [];
      };
    };

    Functions: {
      /** 定期処理（service_role）専用。authenticated からは EXECUTE を剥がしてある。 */
      due_monitors: {
        Args: { p_tolerance_seconds?: number; p_limit?: number };
        Returns: {
          id: string;
          name: string;
          url: string;
          method: Database['public']['Enums']['http_method'];
          expected_status_code: number | null;
          timeout_ms: number;
          failure_threshold: number;
          current_status: Database['public']['Enums']['monitor_status'];
          consecutive_failures: number;
        }[];
      };

      /** 定期処理（service_role）専用。戻り値は previous_status / status / event を含む。 */
      record_check: {
        Args: {
          p_monitor_id: string;
          p_result: Database['public']['Enums']['check_result'];
          p_status_code?: number | null;
          p_response_time_ms?: number | null;
          p_error_kind?: Database['public']['Enums']['check_error_kind'] | null;
          p_error_message?: string | null;
        };
        Returns: Json;
      };

      /** 定期処理（service_role）専用。削除した行数を返す。 */
      purge_old_checks: {
        Args: { p_retention_days?: number };
        Returns: number;
      };

      /** 画面から呼ぶ。SECURITY INVOKER なので RLS がそのまま効く。 */
      recent_checks: {
        Args: { p_limit?: number };
        Returns: {
          monitor_id: string;
          checked_at: string;
          result: Database['public']['Enums']['check_result'];
          status_code: number | null;
          response_time_ms: number | null;
          error_kind: Database['public']['Enums']['check_error_kind'] | null;
        }[];
      };
    };

    Enums: {
      user_role: 'owner' | 'member';
      monitor_status: 'unknown' | 'up' | 'down';
      check_result: 'up' | 'down';
      check_error_kind: 'timeout' | 'dns' | 'tls' | 'network' | 'status' | 'unknown';
      http_method: 'GET' | 'HEAD';
    };

    CompositeTypes: Record<string, never>;
  };
};

/* -------------------------------------------------------------------------- */
/* よく使う行の別名                                                            */
/* -------------------------------------------------------------------------- */

export type MonitorRow = Database['public']['Tables']['monitors']['Row'];
export type MonitorInsert = Database['public']['Tables']['monitors']['Insert'];
export type MonitorUpdate = Database['public']['Tables']['monitors']['Update'];
export type CheckRow = Database['public']['Tables']['checks']['Row'];
export type ProfileRow = Database['public']['Tables']['profiles']['Row'];
export type MonitorOverviewRow = Database['public']['Views']['monitor_overview']['Row'];
export type RecentCheckRow = Database['public']['Functions']['recent_checks']['Returns'][number];
export type DueMonitorRow = Database['public']['Functions']['due_monitors']['Returns'][number];

/** record_check() の戻り値。jsonb なので、受け取り側でこの形に読み替える。 */
export type RecordCheckResult = {
  monitor_id: string;
  previous_status: Database['public']['Enums']['monitor_status'];
  status: Database['public']['Enums']['monitor_status'];
  consecutive_failures: number;
  event: 'went_down' | 'recovered' | null;
};
