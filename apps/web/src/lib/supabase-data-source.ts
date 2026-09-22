/**
 * 本番のデータ取得。Supabase に直接アクセスする。
 *
 * 認可はここには書かない。どの行が見えるかは RLS が決める（supabase/migrations/…_rls.sql）。
 * このファイルは「何を取りに行くか」だけを持ち、「取ってよいか」は持たない。
 */
import type {
  CheckRow,
  IncidentOverviewRow,
  MonitorFormValues,
  MonitorMemberDetail,
  MonitorOverviewRow,
  PublicStatus,
  StatusPageRow,
} from '@statuspulse/core';
import { normalizeMonitorValues, parseAppError } from '@statuspulse/core';
import type { PostgrestError } from '@supabase/supabase-js';

import type { DashboardData, DataSource, SessionUser } from './data-source';
import { RECENT_CHECK_COUNT } from './data-source';
import { supabase } from './supabase';

/**
 * PostgrestError を画面に出せる Error に変える。
 *
 * DB 関数が付けた機械可読なコード（'MONITOR_NOT_FOUND: …'）があればそれを優先し、
 * 無ければ操作名を添える。「エラーが起きました」だけでは利用者が次の行動を選べない。
 */
function toError(error: PostgrestError, operation: string): Error {
  return parseAppError(error.message) ?? new Error(`${operation}に失敗しました: ${error.message}`);
}

function toSessionUser(
  user: { id: string; email?: string | undefined } | null,
): SessionUser | null {
  if (!user) return null;
  const email = user.email ?? '';
  return { id: user.id, email, displayName: email.split('@')[0] ?? 'ユーザー' };
}

/**
 * フォームの値を monitors の列名に写す。
 * camelCase と snake_case の橋渡しと、URL の正規化はここだけで行う。
 */
function toMonitorColumns(input: MonitorFormValues) {
  const values = normalizeMonitorValues(input);

  return {
    name: values.name,
    url: values.url,
    method: values.method,
    expected_status_code: values.expectedStatusCode,
    interval_seconds: values.intervalSeconds,
    timeout_ms: values.timeoutMs,
    failure_threshold: values.failureThreshold,
    expected_body_text: values.expectedBodyText,
    check_certificate: values.checkCertificate,
    is_enabled: values.isEnabled,
  };
}

export function createSupabaseDataSource(): DataSource {
  return {
    kind: 'supabase',

    async getSession() {
      const { data } = await supabase.auth.getSession();
      return toSessionUser(data.session?.user ?? null);
    },

    onAuthStateChange(listener) {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        listener(toSessionUser(session?.user ?? null));
      });
      return () => data.subscription.unsubscribe();
    },

    async signIn(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw new Error('ログインできませんでした: ' + error.message);
    },

    async signUp(email, password) {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) throw new Error('アカウントを作成できませんでした: ' + error.message);
    },

    async signOut() {
      await supabase.auth.signOut();
    },

    /**
     * ダッシュボードに必要なものを2回の往復で取る。
     *
     *   1. monitor_overview  — 監視対象と稼働率（DB 側で集計済み）
     *   2. recent_checks()   — 対象ごとの直近チェック（帯の表示用）
     *
     * 稼働率をここで計算しないのは、7日ぶんのチェックが1対象で1万行を超えるため。
     * 帯に使う直近ぶんだけを別に取る形にして、運ぶ量を一定に保つ。
     */
    async loadDashboard(): Promise<DashboardData> {
      const [overview, recent] = await Promise.all([
        supabase
          .from('monitor_overview')
          .select('*')
          // 異常なものを上に出す。監視ツールで最初に見るべきは「今おかしいもの」。
          .order('current_status', { ascending: false })
          .order('name', { ascending: true }),
        supabase.rpc('recent_checks', { p_limit: RECENT_CHECK_COUNT }),
      ]);

      if (overview.error) throw toError(overview.error, '監視対象の取得');
      if (recent.error) throw toError(recent.error, 'チェック履歴の取得');

      const recentChecks: DashboardData['recentChecks'] = {};
      for (const row of recent.data ?? []) {
        (recentChecks[row.monitor_id] ??= []).push(row);
      }
      // DB からは新しい順で返るので、帯を左から右へ時系列に描けるよう並べ替える。
      for (const rows of Object.values(recentChecks)) {
        rows.reverse();
      }

      return { monitors: (overview.data ?? []) as MonitorOverviewRow[], recentChecks };
    },

    async loadMonitorChecks(monitorId, limit): Promise<CheckRow[]> {
      const { data, error } = await supabase
        .from('checks')
        .select('*')
        .eq('monitor_id', monitorId)
        .order('checked_at', { ascending: false })
        .limit(limit);

      if (error) throw toError(error, 'チェック履歴の取得');
      return (data ?? []) as CheckRow[];
    },

    async loadIncidents({ monitorId, limit }) {
      let query = supabase
        .from('incident_overview')
        .select('*')
        // 継続中（ended_at が null）も started_at の新しい順に混ざる。
        // 「今起きていること」と「直前に起きたこと」を同じ並びで読めるようにするため。
        .order('started_at', { ascending: false })
        .limit(limit);

      if (monitorId) query = query.eq('monitor_id', monitorId);

      const { data, error } = await query;
      if (error) throw toError(error, 'ダウンタイム履歴の取得');
      return (data ?? []) as IncidentOverviewRow[];
    },

    async setIncidentPostmortem(incidentId, text, isPublic) {
      const { error } = await supabase.rpc('set_incident_postmortem', {
        p_incident_id: incidentId,
        p_postmortem: text,
        p_is_public: isPublic,
      });
      if (error) throw toError(error, 'ポストモーテムの保存');
    },

    async createMonitor(values) {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) throw new Error('ログインが必要です');

      // owner_id は RLS の with check でも検証される。ここで入れるのは
      // 「自分のものとして作る」という意図の表明であって、防御ではない。
      const { error } = await supabase
        .from('monitors')
        .insert({ owner_id: auth.user.id, ...toMonitorColumns(values) });

      if (error) {
        if (error.code === '23505') {
          throw new Error('同じ URL の監視対象がすでに登録されています');
        }
        throw toError(error, '監視対象の登録');
      }
    },

    async updateMonitor(monitorId, values) {
      const { error } = await supabase
        .from('monitors')
        .update(toMonitorColumns(values))
        .eq('id', monitorId);

      if (error) {
        if (error.code === '23505') {
          throw new Error('同じ URL の監視対象がすでに登録されています');
        }
        throw toError(error, '監視対象の更新');
      }
    },

    async deleteMonitor(monitorId) {
      const { error } = await supabase.from('monitors').delete().eq('id', monitorId);
      if (error) throw toError(error, '監視対象の削除');
    },

    /* ---------------------------------------------------------------- */
    /* 共有                                                              */
    /* ---------------------------------------------------------------- */

    async loadMembers(monitorId) {
      // auth.users はブラウザから読めないので、メールを返す関数を経由する。
      const { data, error } = await supabase.rpc('monitor_members_of', {
        p_monitor_id: monitorId,
      });
      if (error) throw toError(error, 'メンバーの取得');
      return (data ?? []) as MonitorMemberDetail[];
    },

    async addMember(monitorId, email, role) {
      const { error } = await supabase.rpc('add_monitor_member', {
        p_monitor_id: monitorId,
        p_email: email,
        p_role: role,
      });
      if (error) throw toError(error, 'メンバーの追加');
    },

    async setMemberRole(monitorId, userId, role) {
      const { error } = await supabase.rpc('set_monitor_member_role', {
        p_monitor_id: monitorId,
        p_user_id: userId,
        p_role: role,
      });
      if (error) throw toError(error, '役割の変更');
    },

    async removeMember(monitorId, userId) {
      const { error } = await supabase.rpc('remove_monitor_member', {
        p_monitor_id: monitorId,
        p_user_id: userId,
      });
      if (error) throw toError(error, 'メンバーの削除');
    },

    /* ---------------------------------------------------------------- */
    /* 公開ステータスページ                                              */
    /* ---------------------------------------------------------------- */

    async publishStatusPage(monitorId, title, description) {
      const { data, error } = await supabase.rpc('publish_status_page', {
        p_monitor_id: monitorId,
        p_title: title,
        p_description: description,
      });
      if (error) throw toError(error, '公開ページの発行');
      return data as StatusPageRow;
    },

    async rotateStatusPageSlug(monitorId) {
      const { data, error } = await supabase.rpc('rotate_status_page_slug', {
        p_monitor_id: monitorId,
      });
      if (error) throw toError(error, 'URL の再発行');
      return data as StatusPageRow;
    },

    async setStatusPagePublished(monitorId, isPublished) {
      const { data, error } = await supabase.rpc('set_status_page_published', {
        p_monitor_id: monitorId,
        p_is_published: isPublished,
      });
      if (error) throw toError(error, '公開設定の変更');
      return data as StatusPageRow;
    },

    /**
     * 公開ページ。anon キーのまま呼ぶ。
     *
     * この経路だけはテーブルに一切触らない。public_status() が
     * anon に開かれている唯一の関数で、slug を知らなければ何も返らない。
     */
    async loadPublicStatus(slug) {
      const { data, error } = await supabase.rpc('public_status', { p_slug: slug });
      if (error) throw toError(error, 'ステータスの取得');
      return (data as PublicStatus | null) ?? null;
    },
  };
}
