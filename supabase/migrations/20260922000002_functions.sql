-- =============================================================================
-- StatusPulse / RPC 関数と集計ビュー
--
-- なぜ DB 関数に置くのか:
--   1回のチェックは「checks に1行追記する」「monitors の判定を更新する」の2つの書き込みで、
--   片方だけが成功した状態を作ってはならない。
--   本システムは独自の API サーバーを持たないため、不可分に実行すべき処理は
--   Postgres 関数（= 1トランザクション）に閉じ、行ロックで直列化する。
--
--   結果として「checks を経由せずに判定だけ書き換える」経路も塞げる（0003_rls.sql）。
--
-- 判定の規則そのものは packages/core/src/monitor.ts の nextMonitorState() にもある。
-- これは重複だが役割が違う。DB 側は規則を「守らせる」、TypeScript 側は規則を「見せる」
-- （画面とテストで規則そのものを検証する）。詳細は docs/decisions.md。
--
-- エラー表現:
--   クライアントで分岐できるよう、メッセージ先頭に機械可読なコードを付ける。
--   TypeScript 側の対応表は packages/core/src/errors.ts。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 認証チェック
-- SECURITY DEFINER 関数は RLS を迂回するため、入口で必ず確認する。
-- 定期処理（Cloudflare Workers）は service_role で接続するので、そちらも許可する。
-- -----------------------------------------------------------------------------
create or replace function assert_authenticated() returns uuid
language plpgsql
stable
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  -- nullif を挟むのは、設定が空文字のときに ''::jsonb が例外になるため。
  -- 未設定（NULL）と空文字の両方を「ロール指定なし」として扱う。
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
begin
  if v_uid is null and v_role <> 'service_role' then
    raise exception 'UNAUTHENTICATED: この操作には認証が必要です'
      using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

-- -----------------------------------------------------------------------------
-- record_check: チェック結果を記録する唯一の入口
--
-- checks への追記と monitors の判定更新を、必ず同じトランザクションで行う。
-- 行ロック（select ... for update）により、同一対象への同時記録はここで直列化される。
-- Cron が二重起動しても consecutive_failures が競合して壊れることはない。
--
-- 戻り値に previous_status と event を含めるのは、呼び出し側が
-- 「前の状態と比べる」処理を独自に持たなくて済むようにするため。
-- Phase 2 のダウンタイム記録と Slack 通知はこの event を起点にする。
-- -----------------------------------------------------------------------------
create or replace function record_check(
  p_monitor_id uuid,
  p_result check_result,
  p_status_code integer default null,
  p_response_time_ms integer default null,
  p_error_kind check_error_kind default null,
  p_error_message text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_monitor monitors%rowtype;
  v_failures integer;
  v_status monitor_status;
  v_event text;
begin
  perform assert_authenticated();

  select * into v_monitor from monitors where id = p_monitor_id for update;

  if not found then
    raise exception 'MONITOR_NOT_FOUND: 監視対象が見つかりません（id=%）', p_monitor_id
      using errcode = 'P0002';
  end if;

  -- 観測を先に確定させる。判定の規則は後から変わりうるが、観測は事実なので必ず残す。
  insert into checks (
    monitor_id, result, status_code, response_time_ms, error_kind, error_message
  ) values (
    p_monitor_id, p_result, p_status_code, p_response_time_ms, p_error_kind, p_error_message
  );

  if p_result = 'up' then
    -- 成功したら失敗カウントは即座に 0 に戻す。
    -- 窓（直近N回中M回）で判定しないのは、復旧の検知が遅れるため。
    v_failures := 0;
    v_status := 'up';
    v_event := case when v_monitor.current_status = 'down' then 'recovered' end;
  else
    v_failures := v_monitor.consecutive_failures + 1;
    -- 閾値に届くまでは直前の状態を維持する（登録直後なら unknown のまま）。
    v_status := case
      when v_failures >= v_monitor.failure_threshold then 'down'
      else v_monitor.current_status
    end;
    v_event := case
      when v_status = 'down' and v_monitor.current_status <> 'down' then 'went_down'
    end;
  end if;

  update monitors set
    current_status = v_status,
    consecutive_failures = v_failures,
    -- 成否にかかわらず「試みた時刻」を入れる。
    -- 失敗時に更新しないと、落ちている対象だけが毎分チェックされ続ける。
    last_checked_at = now(),
    status_changed_at = case
      when v_status is distinct from v_monitor.current_status then now()
      else v_monitor.status_changed_at
    end
  where id = p_monitor_id;

  return jsonb_build_object(
    'monitor_id', p_monitor_id,
    'previous_status', v_monitor.current_status,
    'status', v_status,
    'consecutive_failures', v_failures,
    'event', v_event
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- due_monitors: 今チェックすべき対象を返す
--
-- Cron Triggers は1本（毎分起動）だけにして、間隔の判定はここで行う。
-- 対象ごとに異なる間隔を cron 式で表現することはできず、
-- 監視対象を追加するたびに Worker を再デプロイするのは筋が悪い。
--
-- p_tolerance_seconds:
--   判定を許容幅ぶん早める。Cron の起動時刻には数秒のぶれがあり、
--   厳密に比較すると 1分間隔の対象で経過が 59.4 秒になった回が飛ばされ、
--   次の起動まで待って実質2分間隔になる。既定 30 秒（起動周期の半分）。
--   TypeScript 側の同じ規則は packages/core/src/monitor.ts の isCheckDue()。
--
-- p_limit:
--   1回の起動で扱う上限。Workers には1リクエストあたりのサブリクエスト数上限があり、
--   対象が増えたときに全件を1回で処理しようとすると、途中で打ち切られて
--   「後ろに並んだ対象だけ永久にチェックされない」状態になる。
--   last_checked_at の古い順に並べてあるので、上限に当たっても次の起動で回収される。
-- -----------------------------------------------------------------------------
create or replace function due_monitors(
  p_tolerance_seconds integer default 30,
  p_limit integer default 200
) returns table (
  id uuid,
  name text,
  url text,
  method http_method,
  expected_status_code integer,
  timeout_ms integer,
  failure_threshold integer,
  current_status monitor_status,
  consecutive_failures integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    m.id, m.name, m.url, m.method, m.expected_status_code, m.timeout_ms,
    m.failure_threshold, m.current_status, m.consecutive_failures
  from monitors m
  where m.is_enabled
    and (
      m.last_checked_at is null
      or m.last_checked_at <= now() - make_interval(
           secs => greatest(m.interval_seconds - p_tolerance_seconds, 0)
         )
    )
  order by m.last_checked_at nulls first
  limit p_limit;
$$;

-- -----------------------------------------------------------------------------
-- purge_old_checks: 古い観測ログの削除
--
-- 1対象を1分間隔で監視すると年間 50 万行を超える。
-- Phase 1 の画面が使うのは直近7日ぶんなので、既定で30日を超えた行を消す。
--
-- 消す前に日次へ集約しておけば長期の稼働率を残せるが、それは
-- 「1年前の月次稼働率を見たい」という要求が出てから作る。
-- 今作ると、使われない集約テーブルと、その整合を保つ責任だけが残る。
-- -----------------------------------------------------------------------------
create or replace function purge_old_checks(p_retention_days integer default 30)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted bigint;
begin
  delete from checks
  where checked_at < now() - make_interval(days => p_retention_days);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- -----------------------------------------------------------------------------
-- monitor_overview: 一覧画面が必要とするものを1回の往復で返すビュー
--
-- 稼働率の集計をクライアント側に置かないのは、単純にデータ量の問題。
-- 7日ぶんのチェックは1分間隔の対象1つで1万行を超える。
-- 「画面のために全件を運ぶ」構造になった時点で、集計は DB 側にあるべきになる。
--
-- security_invoker = on:
--   ビューは既定でビュー所有者の権限で実行され、元テーブルの RLS を迂回する。
--   権限の境界を DB に置く設計上、ビューだけ例外にはできない。
--
-- 7日ぶんを一度だけ走査し、24時間ぶんは filter で切り出す。
-- 期間ごとに別々のサブクエリを書くと、同じ索引を2回走査することになる。
-- -----------------------------------------------------------------------------
create view monitor_overview with (security_invoker = on) as
select
  m.id,
  m.owner_id,
  m.name,
  m.url,
  m.method,
  m.expected_status_code,
  m.interval_seconds,
  m.timeout_ms,
  m.is_enabled,
  m.current_status,
  m.consecutive_failures,
  m.failure_threshold,
  m.last_checked_at,
  m.status_changed_at,
  m.created_at,
  m.updated_at,

  coalesce(agg.checks_24h, 0)::integer as checks_24h,
  coalesce(agg.up_24h, 0)::integer as up_24h,
  coalesce(agg.checks_7d, 0)::integer as checks_7d,
  coalesce(agg.up_7d, 0)::integer as up_7d,

  -- 応答が返ったチェックだけの平均（応答時間が NULL の行は avg が自動的に無視する）。
  -- 500 が返ったチェックも「応答は返っている」ので平均に含める。
  agg.avg_response_time_ms::integer as avg_response_time_ms,

  latest.status_code as last_status_code,
  latest.response_time_ms as last_response_time_ms,
  latest.error_kind as last_error_kind,
  latest.error_message as last_error_message
from monitors m
left join lateral (
  select
    count(*) filter (where c.checked_at >= now() - interval '24 hours') as checks_24h,
    count(*) filter (
      where c.checked_at >= now() - interval '24 hours' and c.result = 'up'
    ) as up_24h,
    count(*) as checks_7d,
    count(*) filter (where c.result = 'up') as up_7d,
    round(avg(c.response_time_ms) filter (
      where c.checked_at >= now() - interval '24 hours'
    )) as avg_response_time_ms
  from checks c
  where c.monitor_id = m.id
    and c.checked_at >= now() - interval '7 days'
) agg on true
left join lateral (
  select c.status_code, c.response_time_ms, c.error_kind, c.error_message
  from checks c
  where c.monitor_id = m.id
  order by c.checked_at desc
  limit 1
) latest on true;

-- -----------------------------------------------------------------------------
-- recent_checks: 一覧に出す「直近のチェック」の帯
--
-- 対象ごとに新しい順で N 件。lateral で対象ごとに索引を辿るので、
-- 全件を取得して後から絞る形にはしない。
--
-- 帯を出すのは、稼働率の数字だけでは「いつ落ちたか」が分からないため。
-- 99.5% という数字は、1回の長い障害でも、細かい失敗の散らばりでも同じ値になる。
-- -----------------------------------------------------------------------------
create or replace function recent_checks(p_limit integer default 40)
returns table (
  monitor_id uuid,
  checked_at timestamptz,
  result check_result,
  status_code integer,
  response_time_ms integer,
  error_kind check_error_kind
)
language sql
stable
set search_path = public
as $$
  select c.monitor_id, c.checked_at, c.result, c.status_code, c.response_time_ms, c.error_kind
  from monitors m
  cross join lateral (
    select ck.monitor_id, ck.checked_at, ck.result, ck.status_code, ck.response_time_ms, ck.error_kind
    from checks ck
    where ck.monitor_id = m.id
    order by ck.checked_at desc
    limit least(p_limit, 200)
  ) c;
$$;
