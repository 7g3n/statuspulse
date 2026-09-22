-- =============================================================================
-- StatusPulse / Phase 4: 本文チェック・証明書の期限・ポストモーテム
--
-- ここまでの3フェーズは「到達できるか」を見てきた。Phase 4 で足すのは、
-- 到達できていても壊れている状態を捉えるための2つと、記録を残すための1つ。
--
--   1. 本文チェック   — 200 が返っていても中身が違うことがある
--   2. 証明書の期限   — 切れる前に気付かないと、切れた瞬間に全員が入れなくなる
--   3. ポストモーテム — 障害の記録に「何が起きたか」を人の言葉で残す
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. レスポンス本文のチェック
--
-- ステータスコードだけを見ていると、次のような障害を取りこぼす。
--   - アプリが落ちて、前段のプロキシが 200 でメンテナンス画面を返している
--   - デプロイに失敗して、中身が空のページが配信されている
--   - API が 200 で `{"error": ...}` を返している
--
-- 正規表現ではなく「含まれているか」だけにする。
-- 正規表現は書き手が意図しない量の計算を招きうる（Worker の実行時間を食う）うえ、
-- 監視の設定としては「この文字列が消えたら異常」で足りることがほとんど。
-- -----------------------------------------------------------------------------
alter table monitors
  add column expected_body_text text
    check (expected_body_text is null or char_length(expected_body_text) between 1 and 200);

-- HEAD では本文が返らないので、本文チェックとは両立しない。
-- 画面側でも選べないようにするが、DB 側にも書いておく。
alter table monitors
  add constraint monitors_body_check_needs_get check (
    expected_body_text is null or method = 'GET'
  );

-- 定期処理に expected_body_text を渡す。戻り値の型が変わるので作り直す。
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
  expected_body_text text,
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
    m.id, m.name, m.url, m.method, m.expected_status_code, m.expected_body_text,
    m.interval_seconds, m.timeout_ms, m.failure_threshold,
    m.current_status, m.consecutive_failures
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
-- 2. TLS 証明書の有効期限
--
-- 判定のキャッシュと同じ扱いで、record_certificate() だけが更新する列にする。
-- 別テーブルにしないのは、監視対象ごとに「今の証明書」が1つあれば足りるため。
-- 履歴が要るのは「いつ更新されたか」を追いたくなったときで、それはまだ無い。
-- -----------------------------------------------------------------------------
alter table monitors
  -- https でない対象では常に false。画面から切り替えられる。
  add column check_certificate boolean not null default true,
  add column certificate_expires_at timestamptz,
  add column certificate_issuer text,
  add column certificate_checked_at timestamptz,
  -- 取得できなかった理由。取得の失敗と「期限が近い」は別の話なので列を分ける。
  add column certificate_error text;

-- 期限が近い順に引く。証明書を持たない対象は載せない。
create index monitors_certificate_expiry_idx on monitors (certificate_expires_at)
  where certificate_expires_at is not null;

/**
 * 証明書の検査結果を記録する。定期処理（service_role）専用。
 *
 * チェックの記録（record_check）と分けてあるのは、頻度がまったく違うため。
 * 到達性は1〜60分ごとに見るが、証明書の期限は1日1回で足りる
 * （有効期限は数か月単位で、1時間で状況が変わるものではない）。
 * 同じ関数にまとめると、毎分の TLS ハンドシェイクを監視先に強いることになる。
 */
create or replace function record_certificate(
  p_monitor_id uuid,
  p_expires_at timestamptz default null,
  p_issuer text default null,
  p_error text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_authenticated();

  update monitors set
    certificate_expires_at = p_expires_at,
    certificate_issuer = p_issuer,
    certificate_error = p_error,
    certificate_checked_at = now()
  where id = p_monitor_id;
end;
$$;

/**
 * 証明書を検査すべき対象を返す。定期処理（service_role）専用。
 *
 * 1日1回でよいので、最後の検査から 20 時間以上経ったものだけを返す。
 * ちょうど 24 時間にすると、毎日わずかに遅れていき検査時刻が一周してしまう。
 */
create or replace function due_certificate_checks(p_limit integer default 20)
returns table (
  id uuid,
  name text,
  url text
)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.name, m.url
  from monitors m
  where m.is_enabled
    and m.check_certificate
    and m.url like 'https://%'
    and (
      m.certificate_checked_at is null
      or m.certificate_checked_at <= now() - interval '20 hours'
    )
  order by m.certificate_checked_at nulls first
  limit p_limit;
$$;

-- -----------------------------------------------------------------------------
-- 3. ポストモーテム（障害のメモ）
--
-- incidents に列として持つ。障害と1対1で、障害が消えればメモも意味を失うため。
--
-- postmortem_is_public を別に持つのは、書くことと公開することを分けるため。
-- 社内向けの生々しいメモと、利用者向けの説明は普通は別物になる。
-- ここを1つのフラグにすると、「公開したくないから書かない」が起きる。
-- -----------------------------------------------------------------------------
alter table incidents
  add column postmortem text not null default ''
    check (char_length(postmortem) <= 4000),
  add column postmortem_is_public boolean not null default false,
  add column postmortem_updated_at timestamptz,
  add column postmortem_updated_by uuid references auth.users (id) on delete set null;

create or replace function set_incident_postmortem(
  p_incident_id uuid,
  p_postmortem text,
  p_is_public boolean default false
) returns incidents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := assert_authenticated();
  v_monitor_id uuid;
  v_incident incidents;
begin
  select monitor_id into v_monitor_id from incidents where id = p_incident_id;

  if v_monitor_id is null or not can_edit_monitor(v_monitor_id) then
    -- 権限が無い場合と存在しない場合を区別しない（Phase 3 と同じ方針）。
    raise exception 'INCIDENT_NOT_FOUND: 障害の記録が見つかりません'
      using errcode = 'P0002';
  end if;

  update incidents set
    postmortem = coalesce(p_postmortem, ''),
    postmortem_is_public = p_is_public,
    -- 本文が空になったら「書かれていない」状態に戻す。
    postmortem_updated_at = case when coalesce(p_postmortem, '') = '' then null else now() end,
    postmortem_updated_by = case when coalesce(p_postmortem, '') = '' then null else v_uid end
  where id = p_incident_id
  returning * into v_incident;

  return v_incident;
end;
$$;

-- -----------------------------------------------------------------------------
-- ビューの張り替え
-- -----------------------------------------------------------------------------
drop view incident_overview;

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
  i.postmortem,
  i.postmortem_is_public,
  i.postmortem_updated_at,
  down_notice.status as down_notification_status,
  up_notice.status as recovered_notification_status
from incidents i
join monitors m on m.id = i.monitor_id
left join notifications down_notice
  on down_notice.incident_id = i.id and down_notice.kind = 'monitor_down'
left join notifications up_notice
  on up_notice.incident_id = i.id and up_notice.kind = 'monitor_recovered';

grant select on incident_overview to authenticated;

drop view monitor_overview;

create view monitor_overview with (security_invoker = on) as
select
  m.id,
  m.owner_id,
  m.name,
  m.url,
  m.method,
  m.expected_status_code,
  m.expected_body_text,
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

  m.check_certificate,
  m.certificate_expires_at,
  m.certificate_issuer,
  m.certificate_checked_at,
  m.certificate_error,

  coalesce(agg.checks_24h, 0)::integer as checks_24h,
  coalesce(agg.up_24h, 0)::integer as up_24h,
  coalesce(agg.checks_7d, 0)::integer as checks_7d,
  coalesce(agg.up_7d, 0)::integer as up_7d,
  agg.avg_response_time_ms::integer as avg_response_time_ms,

  coalesce(down.seconds_24h, 0)::integer as down_seconds_24h,
  coalesce(down.seconds_7d, 0)::integer as down_seconds_7d,
  coalesce(down.incidents_7d, 0)::integer as incidents_7d,

  open_incident.id as open_incident_id,

  latest.status_code as last_status_code,
  latest.response_time_ms as last_response_time_ms,
  latest.error_kind as last_error_kind,
  latest.error_message as last_error_message,

  current_member_role(m.id) as viewer_role,
  coalesce(members.count, 0)::integer as member_count,
  page.slug as status_page_slug,
  coalesce(page.is_published, false) as status_page_published
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
) latest on true
left join lateral (
  select count(*) as count from monitor_members mm where mm.monitor_id = m.id
) members on true
left join status_pages page on page.monitor_id = m.id;

grant select on monitor_overview to authenticated;

-- -----------------------------------------------------------------------------
-- 公開ページ: 公開が許可されたポストモーテムを載せる
--
-- 障害の記録に「何が起きたか」が書いてあるかどうかで、公開ページの価値は変わる。
-- 「9月17日 30分停止」だけでは、見た人は何も分からないままになる。
--
-- 公開するのは postmortem_is_public が true のものだけ。
-- 書くことと公開することを分けてあるので、社内向けのメモが漏れることはない。
-- -----------------------------------------------------------------------------
create or replace function public_status(p_slug text, p_check_limit integer default 60)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_page status_pages%rowtype;
  v_monitor monitors%rowtype;
  v_now timestamptz := now();
  v_day_window numeric;
  v_week_window numeric;
begin
  select * into v_page from status_pages where slug = p_slug and is_published;
  if not found then
    return null;
  end if;

  select * into v_monitor from monitors where id = v_page.monitor_id;
  if not found then
    return null;
  end if;

  v_day_window := least(86400, extract(epoch from (v_now - v_monitor.created_at)));
  v_week_window := least(604800, extract(epoch from (v_now - v_monitor.created_at)));

  return jsonb_build_object(
    'title', v_page.title,
    'description', v_page.description,
    'status', case when v_monitor.is_enabled then v_monitor.current_status else 'unknown' end,
    'status_changed_at', v_monitor.status_changed_at,
    'interval_seconds', v_monitor.interval_seconds,
    'last_checked_at', v_monitor.last_checked_at,
    'generated_at', v_now,

    'uptime', jsonb_build_object(
      'day', jsonb_build_object(
        'window_seconds', greatest(0, v_day_window),
        'down_seconds', coalesce((
          select sum(greatest(0, extract(epoch from (
            least(coalesce(i.ended_at, v_now), v_now)
            - greatest(i.started_at, v_now - interval '24 hours')
          ))))
          from incidents i where i.monitor_id = v_monitor.id
        ), 0)
      ),
      'week', jsonb_build_object(
        'window_seconds', greatest(0, v_week_window),
        'down_seconds', coalesce((
          select sum(greatest(0, extract(epoch from (
            least(coalesce(i.ended_at, v_now), v_now)
            - greatest(i.started_at, v_now - interval '7 days')
          ))))
          from incidents i where i.monitor_id = v_monitor.id
        ), 0)
      )
    ),

    'checks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'checked_at', c.checked_at,
        'result', c.result,
        'response_time_ms', c.response_time_ms
      ) order by c.checked_at)
      from (
        select c2.checked_at, c2.result, c2.response_time_ms
        from checks c2
        where c2.monitor_id = v_monitor.id
        order by c2.checked_at desc
        limit least(greatest(p_check_limit, 1), 200)
      ) c
    ), '[]'::jsonb),

    'incidents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'started_at', i.started_at,
        'ended_at', i.ended_at,
        'cause', i.cause,
        'duration_seconds', extract(epoch from (coalesce(i.ended_at, v_now) - i.started_at))::integer,
        -- 公開が許可されたメモだけ。許可されていなければキーごと出さない。
        'postmortem', case when i.postmortem_is_public and i.postmortem <> '' then i.postmortem end
      ) order by i.started_at desc)
      from (
        select i2.started_at, i2.ended_at, i2.cause, i2.postmortem, i2.postmortem_is_public
        from incidents i2
        where i2.monitor_id = v_monitor.id
        order by i2.started_at desc
        limit 20
      ) i
    ), '[]'::jsonb)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 権限
-- -----------------------------------------------------------------------------

-- 本文チェックの設定は editor 以上が変更できる（列単位の GRANT に追加）。
grant update (expected_body_text, check_certificate) on monitors to authenticated;

-- 証明書の検査結果は定期処理だけが書く。
revoke execute on function record_certificate(uuid, timestamptz, text, text)
  from public, anon, authenticated;
revoke execute on function due_certificate_checks(integer) from public, anon, authenticated;
grant execute on function record_certificate(uuid, timestamptz, text, text) to service_role;
grant execute on function due_certificate_checks(integer) to service_role;

revoke execute on function set_incident_postmortem(uuid, text, boolean) from public, anon;
grant execute on function set_incident_postmortem(uuid, text, boolean) to authenticated;

-- public_status を差し替えたので、実行権限を張り直す。
revoke execute on function public_status(text, integer) from public;
grant execute on function public_status(text, integer) to anon, authenticated;
