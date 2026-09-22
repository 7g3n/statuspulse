-- =============================================================================
-- StatusPulse / RLS と権限
--
-- 方針:
--   ブラウザから Postgres へ直接アクセスする構成（独自 API サーバーを持たない）なので、
--   「何ができるか」の最終的な境界はアプリのコードではなく DB 側の権限になる。
--   画面で出し分けるのは体験のためであって、防御ではない。
--
--   Phase 1 の分離単位は monitors.owner_id（所有者のみが見える）。
--   Phase 3 のチーム機能と公開ステータスページで、このファイルを張り替える。
--
-- ここで特に気をつけている2点:
--   1. checks は読み取り専用にする。観測ログをアプリから書けると、稼働率を自分で
--      書き換えられることになり、この数字を誰も信用できなくなる。
--   2. 関数の EXECUTE は既定で PUBLIC に付く。定期処理用の関数を明示的に剥がす。
-- =============================================================================

alter table profiles enable row level security;
alter table monitors enable row level security;
alter table checks enable row level security;

-- -----------------------------------------------------------------------------
-- profiles
-- Phase 3 でメンバー一覧を出すため、読み取りは認証済み全員に開いておく。
-- role を自分で昇格できないよう、更新は自分の行に限り、
-- role 列そのものへの UPDATE 権限は後段の列単位 GRANT で外す。
-- -----------------------------------------------------------------------------
create policy profiles_select on profiles
  for select to authenticated
  using (true);

create policy profiles_update_self on profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- -----------------------------------------------------------------------------
-- monitors
-- 所有者だけが読み書きできる。
-- with check を using と同じ条件にしているのは、owner_id を他人の ID に書き換えて
-- 監視対象を「押し付ける」操作を塞ぐため。
-- -----------------------------------------------------------------------------
create policy monitors_select on monitors
  for select to authenticated
  using (owner_id = auth.uid());

create policy monitors_insert on monitors
  for insert to authenticated
  with check (owner_id = auth.uid());

create policy monitors_update on monitors
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy monitors_delete on monitors
  for delete to authenticated
  using (owner_id = auth.uid());

-- -----------------------------------------------------------------------------
-- checks: 読み取り専用
--
-- INSERT / UPDATE / DELETE のポリシーを一切作らない（= RLS により拒否される）ことで、
-- 観測ログへの書き込み経路を record_check()（SECURITY DEFINER）だけに絞る。
-- SECURITY DEFINER 関数は定義者の権限で走るため RLS を通過できる。
--
-- 稼働率は「このログを誰も書き換えていない」ことの上に成り立つ数字なので、
-- ここは Phase 1 の時点から例外を作らない。
-- -----------------------------------------------------------------------------
create policy checks_select on checks
  for select to authenticated
  using (
    exists (
      select 1 from monitors m
      where m.id = checks.monitor_id
        and m.owner_id = auth.uid()
    )
  );

-- -----------------------------------------------------------------------------
-- 列単位の権限
--
-- RLS は「どの行に触れるか」しか決められない。「どの列を書き換えてよいか」は
-- GRANT で決める。判定のキャッシュ（current_status など）は record_check() が
-- 責任を持つ列なので、アプリからの UPDATE 対象から外す。
--
-- 外さないと、ダッシュボードから直接 current_status = 'up' と書けてしまう。
-- 「落ちているのに正常と表示される」状態を、アプリのコードではなく DB で防ぐ。
-- -----------------------------------------------------------------------------
revoke all on monitors from anon, authenticated;
grant select, insert, delete on monitors to authenticated;
grant update (
  name,
  url,
  method,
  expected_status_code,
  interval_seconds,
  timeout_ms,
  is_enabled,
  failure_threshold
) on monitors to authenticated;

-- checks は SELECT のみ。
revoke all on checks from anon, authenticated;
grant select on checks to authenticated;

-- profiles は display_name だけを自分で変更できる。role は Phase 3 で
-- owner 限定の RPC を通して変更する。
revoke all on profiles from anon, authenticated;
grant select on profiles to authenticated;
grant update (display_name) on profiles to authenticated;

-- 集計ビュー（security_invoker = on なので、元テーブルの RLS がそのまま効く）
grant select on monitor_overview to authenticated;

-- -----------------------------------------------------------------------------
-- 関数の実行権限
--
-- Postgres では関数の EXECUTE が既定で PUBLIC に付く。放置すると、
-- ログイン済みの誰でも due_monitors() を呼べてしまう。この関数は SECURITY DEFINER で
-- RLS を迂回するため、**他人の監視対象の URL がそのまま返る**。
-- 定期処理のための関数は、定期処理のロール（service_role）だけに絞る。
-- -----------------------------------------------------------------------------
revoke execute on function record_check(uuid, check_result, integer, integer, check_error_kind, text)
  from public, anon, authenticated;
revoke execute on function due_monitors(integer, integer) from public, anon, authenticated;
revoke execute on function purge_old_checks(integer) from public, anon, authenticated;
revoke execute on function assert_authenticated() from public, anon;

grant execute on function record_check(uuid, check_result, integer, integer, check_error_kind, text)
  to service_role;
grant execute on function due_monitors(integer, integer) to service_role;
grant execute on function purge_old_checks(integer) to service_role;

-- recent_checks は SECURITY INVOKER（呼び出したユーザーの権限で走る）なので、
-- RLS がそのまま効く。画面から呼ぶため authenticated に開く。
grant execute on function recent_checks(integer) to authenticated;
