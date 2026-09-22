/**
 * 画面がデータを取りに行く先の境界。
 *
 * 実装は2つある。
 *   - supabase-data-source.ts — 本番。Supabase に直接アクセスする
 *   - mock-data-source.ts     — Supabase を立てずに、生成したデータで動かす
 *
 * なぜこの層を挟むのか:
 *   デモとスクリーンショットのために「DB と Worker を動かさなくても
 *   本物と同じ画面が出る」状態を作りたい。
 *   各画面の中で `if (isMockMode)` と分岐させると、その分岐が画面の数だけ増え、
 *   どこかで必ず書き漏らす。差し替えの境界をこのファイル1枚に閉じる。
 *
 * 逆にこの層に置かないもの:
 *   整形・判定・集計はここに書かない。それらは @statuspulse/core にあり、
 *   モックと本番で同じ関数を通る。ここが担うのは「取得」だけ。
 *   モックだけ都合よく計算する余地を残すと、モックで確かめた意味が無くなる。
 */

import type {
  CheckRow,
  IncidentOverviewRow,
  MemberRole,
  MonitorFormValues,
  MonitorMemberDetail,
  MonitorOverviewRow,
  PublicStatus,
  RecentCheckRow,
  StatusPageRow,
} from '@statuspulse/core';

import { isMockMode } from './env';
import { createMockDataSource } from './mock-data-source';
import { createSupabaseDataSource } from './supabase-data-source';

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
};

/** 一覧に出す「直近のチェック」の帯に使う件数。 */
export const RECENT_CHECK_COUNT = 40;

export type DashboardData = {
  monitors: MonitorOverviewRow[];
  /** 監視対象 ID → 直近のチェック（古い順）。帯を左から右へ時系列で描くため。 */
  recentChecks: Record<string, RecentCheckRow[]>;
};

export type IncidentQuery = {
  monitorId?: string | undefined;
  limit: number;
};

export type DataSource = {
  readonly kind: 'supabase' | 'mock';

  getSession(): Promise<SessionUser | null>;
  /** 戻り値は購読解除の関数。 */
  onAuthStateChange(listener: (user: SessionUser | null) => void): () => void;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;

  loadDashboard(): Promise<DashboardData>;
  loadMonitorChecks(monitorId: string, limit: number): Promise<CheckRow[]>;
  /** ダウンタイムの履歴。monitorId を省くと全対象ぶんを新しい順で返す。 */
  loadIncidents(options: IncidentQuery): Promise<IncidentOverviewRow[]>;
  /** ポストモーテムの保存（Phase 4）。空文字にすると「未記入」に戻る。 */
  setIncidentPostmortem(incidentId: string, text: string, isPublic: boolean): Promise<void>;

  createMonitor(values: MonitorFormValues): Promise<void>;
  updateMonitor(monitorId: string, values: MonitorFormValues): Promise<void>;
  deleteMonitor(monitorId: string): Promise<void>;

  /* --- 共有（Phase 3） --- */
  loadMembers(monitorId: string): Promise<MonitorMemberDetail[]>;
  addMember(monitorId: string, email: string, role: MemberRole): Promise<void>;
  setMemberRole(monitorId: string, userId: string, role: MemberRole): Promise<void>;
  removeMember(monitorId: string, userId: string): Promise<void>;

  /* --- 公開ステータスページ（Phase 3） --- */
  publishStatusPage(monitorId: string, title: string, description: string): Promise<StatusPageRow>;
  rotateStatusPageSlug(monitorId: string): Promise<StatusPageRow>;
  setStatusPagePublished(monitorId: string, isPublished: boolean): Promise<StatusPageRow>;

  /**
   * 公開ページの内容。**認証していなくても呼べる唯一の取得**。
   * slug が無効でも公開停止中でも null を返す（区別しない）。
   */
  loadPublicStatus(slug: string): Promise<PublicStatus | null>;
};

export const dataSource: DataSource = isMockMode
  ? createMockDataSource()
  : createSupabaseDataSource();
