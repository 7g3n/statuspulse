-- =============================================================================
-- StatusPulse / Phase 2: ダウンタイム履歴と通知
--
-- Phase 1 では「今どうなっているか」しか持っていなかった。
-- checks には1回ごとの点が並ぶだけで、「いつ落ちて、いつ直ったか」という
-- 期間はどこにも無い。この migration で3つを足す。
--
--   1. incidents     — ダウンの期間。タイムライン表示と時間ベースの稼働率の土台
--   2. notifications — 送信前に宣言して重複通知を防ぐ台帳
--   3. first_failure_at — 「最初に失敗した時刻」。閾値N回の判定と、
--                         インシデントの開始時刻を正しく記録するために要る
--
-- Phase 1 の判断5（docs/decisions.md）に書いた「判断が変わる条件」に到達したので、
-- 稼働率の定義もチェック回数ベースから時間ベースへ移す。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- monitors への追加
-- -----------------------------------------------------------------------------

-- 現在続いている失敗の、最初の1回の時刻。成功したら NULL に戻る。
--
-- 閾値を N にすると、down と判定されるのは N 回目のチェックになる。
-- しかし実際に落ちていたのは1回目からで、そこを起点にしないと
-- ダウンタイムが「閾値 × 間隔」ぶん短く記録される。
-- 誤検知を減らすための設定が、稼働率を良く見せる方向に働いてはならない。
alter table monitors add column first_failure_at timestamptz;

-- 既定値を 1 から 2 に変える。
--
-- 1 は「1回の失敗で即ダウン」で、瞬間的な切断でも通知が飛ぶ。
-- かといって大きくすればよいものでもない。閾値 N は検知の遅れを
-- 「間隔 × N」まで伸ばすので、1時間間隔の対象を 3 にすると最大3時間気付けない。
-- 2 は「もう一度確かめてから言う」の最小形で、遅れも1回ぶんに収まる。
-- 対象ごとに画面から変更できる。
alter table monitors alter column failure_threshold set default 2;

-- -----------------------------------------------------------------------------
-- incidents: ダウンの期間
--
-- checks（点）から導かれる集約だが、都度計算せずテーブルとして持つ。
--   - 通知の重複判定に安定した ID が要る（「この障害」を一意に指せる必要がある）
--   - 保持期間を過ぎて checks が消えても、障害の記録は残したい
--   - Phase 4 のポストモーテムは、この行にぶら下げる
-- -----------------------------------------------------------------------------
create table incidents (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null references monitors (id) on delete cascade,

  -- 最初に失敗したチェックの時刻。down と判定した時刻ではない（上述）。
  started_at timestamptz not null,

  -- 復旧を確認したチェックの時刻。NULL は継続中。
  --
  -- 実際に直ったのは「最後の失敗」と「最初の成功」の間のどこかだが、
  -- 監視できていない時間を直っていた側に数えると稼働率が実態より良くなる。
  -- 確認できた時刻を採り、疑わしい区間はダウン側に入れる。
  ended_at timestamptz,

  -- 検知したときの失敗の種類と内容。
  cause check_error_kind not null,
  status_code integer,
  error_message text,

  -- この障害の間に失敗したチェックの回数。
  failure_count integer not null default 1 check (failure_count >= 1),

  created_at timestamptz not null default now(),

  constraint incidents_period_valid check (ended_at is null or ended_at >= started_at)
);

-- 不変条件: 1つの監視対象に、継続中のインシデントは1本まで。
-- 部分一意索引で DB 側に持たせる。record_check() のロジックが壊れても、
-- 「同じ障害が2本記録される」状態にはならない。
create unique index incidents_one_open_per_monitor on incidents (monitor_id)
  where ended_at is null;

create index incidents_monitor_started_idx on incidents (monitor_id, started_at desc);
create index incidents_started_idx on incidents (started_at desc);

-- -----------------------------------------------------------------------------
-- notifications: 送信した（これから送る）通知の台帳
--
-- Cron は同じ時刻に二度走ることがあり、手動実行や再デプロイでも重複しうる。
-- 同じ障害を何度も Slack に流すと、受け取る側は通知を見なくなる。
--
-- dedupe_key を incident の ID から作るのが要点。
-- 「前回の実行時刻からの差分」で追う方式は、実行が飛べば取りこぼし、
-- 二度走れば重複する。障害そのものに紐づく鍵なら、いつ何度走っても結果が同じになる。
-- -----------------------------------------------------------------------------
create type notification_kind as enum ('monitor_down', 'monitor_recovered');
create type notification_status as enum ('pending', 'sent', 'failed', 'skipped');

create table notifications (
  id bigint generated always as identity primary key,
  kind notification_kind not null,

  -- 'monitor_down:<incident_id>' の形。一意制約が重複送信を防ぐ本体。
  dedupe_key text not null,

  monitor_id uuid references monitors (id) on delete set null,
  incident_id uuid references incidents (id) on delete set null,

  payload jsonb not null default '{}'::jsonb,

  -- pending は「宣言したが結果が返っていない」。送信後に sent / failed / skipped へ。
  status notification_status not null default 'pending',

  claimed_at timestamptz not null default now(),
  settled_at timestamptz,
  error_message text
);

create unique index notifications_dedupe_key on notifications (dedupe_key);
create index notifications_claimed_idx on notifications (claimed_at desc);
create index notifications_incident_idx on notifications (incident_id);

-- -----------------------------------------------------------------------------
-- record_check: インシデントの開閉を担うよう拡張する
--
-- Phase 1 と同じく、1回のチェックで起きる書き込みをすべて1トランザクションに閉じる。
-- 対象は4つになった: checks への追記 / monitors の判定更新 /
-- incidents の開閉 / first_failure_at の更新。
-- 行ロックは Phase 1 と同じ select ... for update が効いている。
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
  v_first_failure_at timestamptz;
  v_incident_id uuid;
  v_incident_started_at timestamptz;
begin
  perform assert_authenticated();

  select * into v_monitor from monitors where id = p_monitor_id for update;

  if not found then
    raise exception 'MONITOR_NOT_FOUND: 監視対象が見つかりません（id=%）', p_monitor_id
      using errcode = 'P0002';
  end if;

  -- 観測を先に確定させる。判定の規則は変わりうるが、観測は事実なので必ず残す。
  insert into checks (
    monitor_id, result, status_code, response_time_ms, error_kind, error_message
  ) values (
    p_monitor_id, p_result, p_status_code, p_response_time_ms, p_error_kind, p_error_message
  );

  if p_result = 'up' then
    v_failures := 0;
    v_status := 'up';
    v_first_failure_at := null;
    v_event := case when v_monitor.current_status = 'down' then 'recovered' end;

    -- 継続中のインシデントを閉じる。
    -- current_status を見ずに incidents を直接見るのは、閾値に届かないまま
    -- 失敗が途切れた場合（インシデントは開いていない）と区別する必要がないため。
    update incidents
      set ended_at = now()
      where monitor_id = p_monitor_id and ended_at is null
      returning id, started_at into v_incident_id, v_incident_started_at;
  else
    v_failures := v_monitor.consecutive_failures + 1;

    -- 連続失敗の起点。すでに失敗が続いていればその時刻を引き継ぐ。
    v_first_failure_at := coalesce(v_monitor.first_failure_at, now());

    v_status := case
      when v_failures >= v_monitor.failure_threshold then 'down'
      else v_monitor.current_status
    end;
    v_event := case
      when v_status = 'down' and v_monitor.current_status <> 'down' then 'went_down'
    end;

    if v_event = 'went_down' then
      -- 開始時刻は「最初に失敗した時刻」。閾値ぶんの遅れを稼働率に持ち込まない。
      insert into incidents (
        monitor_id, started_at, cause, status_code, error_message, failure_count
      ) values (
        p_monitor_id, v_first_failure_at,
        coalesce(p_error_kind, 'unknown'), p_status_code, p_error_message, v_failures
      )
      returning id, started_at into v_incident_id, v_incident_started_at;
    else
      -- 継続中なら失敗回数だけ増やす（開いていなければ何も起きない）。
      update incidents
        set failure_count = failure_count + 1
        where monitor_id = p_monitor_id and ended_at is null
        returning id, started_at into v_incident_id, v_incident_started_at;
    end if;
  end if;

  update monitors set
    current_status = v_status,
    consecutive_failures = v_failures,
    first_failure_at = v_first_failure_at,
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
    'failure_threshold', v_monitor.failure_threshold,
    'event', v_event,
    -- 通知の重複判定に使う。event が null のときも、継続中の障害を指す ID が入る。
    'incident_id', v_incident_id,
    'incident_started_at', v_incident_started_at
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- due_monitors: 通知の本文に必要な interval_seconds を足す
--
-- 戻り値の型が変わるので create or replace ではなく作り直す。
-- 間隔を返すのは、ダウン通知に「閾値 N 回 = 最大どれだけの検知遅れか」を
-- 書くため。閾値だけでは受け取った人が遅れの大きさを判断できない。
-- -----------------------------------------------------------------------------
drop function due_monitors(integer, integer);

create function due_monitors(
  p_tolerance_seconds integer default 30,
  p_limit integer default 200
) returns table (
  id uuid,
  name text,
  url text,
  method http_method,
  expected_status_code integer,
  interval_seconds integer,
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
    m.id, m.name, m.url, m.method, m.expected_status_code, m.interval_seconds,
    m.timeout_ms, m.failure_threshold, m.current_status, m.consecutive_failures
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

revoke execute on function due_monitors(integer, integer) from public, anon, authenticated;
grant execute on function due_monitors(integer, integer) to service_role;

-- -----------------------------------------------------------------------------
-- claim_notification: これから送る通知を宣言する
--
-- 既に同じ鍵の記録があれば false（= 送らない）。
-- 判定と記録を別のクエリに分けず、DB 側の一意制約で決めている。
-- 分けると、その隙間で複数の Worker が両方とも「まだ送っていない」と判断しうる。
--
-- **送信より先に記録する。** 逆にすると、送信成功後に記録へ失敗したときに
-- 二重送信になる。先に記録すると送信失敗時に通知が欠けるが、
-- 欠けたことは status = 'failed' として画面に残る（黙って消えない）。
-- -----------------------------------------------------------------------------
create or replace function claim_notification(
  p_kind notification_kind,
  p_dedupe_key text,
  p_monitor_id uuid,
  p_incident_id uuid,
  p_payload jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer;
begin
  perform assert_authenticated();

  insert into notifications (kind, dedupe_key, monitor_id, incident_id, payload)
  values (p_kind, p_dedupe_key, p_monitor_id, p_incident_id, p_payload)
  on conflict (dedupe_key) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted > 0;
end;
$$;

-- -----------------------------------------------------------------------------
-- settle_notification: 送信の結果を書き戻す
--
-- 通知が届かなかったとき、「送っていない」のか「送ったが届いていない」のかを
-- 切り分けられるようにするための記録。
-- -----------------------------------------------------------------------------
create or replace function settle_notification(
  p_dedupe_key text,
  p_status notification_status,
  p_error_message text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_authenticated();

  update notifications
    set status = p_status,
        settled_at = now(),
        error_message = p_error_message
    where dedupe_key = p_dedupe_key;
end;
$$;

-- -----------------------------------------------------------------------------
-- monitor_overview: 時間ベースの稼働率へ
--
-- Phase 1 はチェック回数ベース（成功回数 ÷ 実行回数）だった。
-- 定義としては時間ベース（停止していた時間 ÷ 対象期間）の方が正しく、
-- incidents が揃った今それが計算できる。
--
-- 回数も引き続き返す。分母がどれだけの観測に支えられているかは、
-- 稼働率の数字そのものとは別に知る必要があるため
-- （12回中12回の 100% と 2016回中2016回の 100% は重みが違う）。
-- -----------------------------------------------------------------------------
drop view monitor_overview;

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
  m.first_failure_at,
  m.last_checked_at,
  m.status_changed_at,
  m.created_at,
  m.updated_at,

  coalesce(agg.checks_24h, 0)::integer as checks_24h,
  coalesce(agg.up_24h, 0)::integer as up_24h,
  coalesce(agg.checks_7d, 0)::integer as checks_7d,
  coalesce(agg.up_7d, 0)::integer as up_7d,
  agg.avg_response_time_ms::integer as avg_response_time_ms,

  -- 期間と重なるぶんだけを足す。期間の外へはみ出した障害は切り詰める。
  coalesce(down.seconds_24h, 0)::integer as down_seconds_24h,
  coalesce(down.seconds_7d, 0)::integer as down_seconds_7d,
  coalesce(down.incidents_7d, 0)::integer as incidents_7d,

  open_incident.id as open_incident_id,

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
  select
    sum(greatest(0, extract(epoch from (
      least(coalesce(i.ended_at, now()), now())
      - greatest(i.started_at, now() - interval '24 hours')
    )))) as seconds_24h,
    sum(greatest(0, extract(epoch from (
      least(coalesce(i.ended_at, now()), now())
      - greatest(i.started_at, now() - interval '7 days')
    )))) as seconds_7d,
    count(*) as incidents_7d
  from incidents i
  where i.monitor_id = m.id
    and coalesce(i.ended_at, now()) >= now() - interval '7 days'
) down on true
left join lateral (
  select i.id from incidents i
  where i.monitor_id = m.id and i.ended_at is null
  limit 1
) open_incident on true
left join lateral (
  select c.status_code, c.response_time_ms, c.error_kind, c.error_message
  from checks c
  where c.monitor_id = m.id
  order by c.checked_at desc
  limit 1
) latest on true;

-- -----------------------------------------------------------------------------
-- incident_overview: タイムライン画面が使うビュー
--
-- 通知の状態を一緒に返すのは、「通知が来なかった」ときに
-- 送っていないのか、送ったが届いていないのかを切り分けられるようにするため。
-- -----------------------------------------------------------------------------
create view incident_overview with (security_invoker = on) as
select
  i.id,
  i.monitor_id,
  m.name as monitor_name,
  m.url as monitor_url,
  m.is_enabled as monitor_is_enabled,
  i.started_at,
  i.ended_at,
  i.cause,
  i.status_code,
  i.error_message,
  i.failure_count,
  extract(epoch from (coalesce(i.ended_at, now()) - i.started_at))::integer as duration_seconds,
  down_notice.status as down_notification_status,
  up_notice.status as recovered_notification_status
from incidents i
join monitors m on m.id = i.monitor_id
left join notifications down_notice
  on down_notice.incident_id = i.id and down_notice.kind = 'monitor_down'
left join notifications up_notice
  on up_notice.incident_id = i.id and up_notice.kind = 'monitor_recovered';

-- -----------------------------------------------------------------------------
-- 権限
-- 方針は Phase 1 と同じ。
--   - 観測と履歴はアプリから書けない（incidents / notifications ともに SELECT のみ）
--   - 定期処理のための関数は service_role だけに開く
-- -----------------------------------------------------------------------------
alter table incidents enable row level security;
alter table notifications enable row level security;

create policy incidents_select on incidents
  for select to authenticated
  using (
    exists (
      select 1 from monitors m
      where m.id = incidents.monitor_id and m.owner_id = auth.uid()
    )
  );

create policy notifications_select on notifications
  for select to authenticated
  using (
    exists (
      select 1 from monitors m
      where m.id = notifications.monitor_id and m.owner_id = auth.uid()
    )
  );

revoke all on incidents from anon, authenticated;
grant select on incidents to authenticated;

revoke all on notifications from anon, authenticated;
grant select on notifications to authenticated;

grant select on incident_overview to authenticated;
grant select on monitor_overview to authenticated;

revoke execute on function claim_notification(notification_kind, text, uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke execute on function settle_notification(text, notification_status, text)
  from public, anon, authenticated;

grant execute on function claim_notification(notification_kind, text, uuid, uuid, jsonb)
  to service_role;
grant execute on function settle_notification(text, notification_status, text)
  to service_role;

-- record_check は差し替えたので EXECUTE を張り直す。
revoke execute on function record_check(uuid, check_result, integer, integer, check_error_kind, text)
  from public, anon, authenticated;
grant execute on function record_check(uuid, check_result, integer, integer, check_error_kind, text)
  to service_role;

-- first_failure_at は判定のキャッシュ列。アプリからは書かせない
-- （Phase 1 の列単位 GRANT に追加はせず、そのまま対象外のままにする）。
