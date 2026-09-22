-- =============================================================================
-- StatusPulse / Phase 3: チームでの共有と公開ステータスページ
--
-- Phase 1 で引いた権限の境界（monitors.owner_id = auth.uid()）を、ここで初めて
-- 張り替える。広げる方向は2つあり、性格がまったく違う。
--
--   1. チーム   — 「認証済みの、許可された人」へ広げる（monitor_members）
--   2. 公開ページ — 「認証すらしていない人」へ広げる（status_pages）
--
-- 1 は RLS のポリシーを書き換える話だが、2 はそうではない。
-- テーブルを anon に開くと「公開中の監視対象を全部列挙する」ことができてしまい、
-- 他人の公開ページとその監視先 URL まで引ける。
-- そこで 2 は **slug を引数に取る関数だけを anon に開く** 形で実装する。
-- slug は「知っていること自体が権限」であり、当てずっぽうでは何も返らない。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 役割
--
-- Phase 1 の profiles.role（owner / member）はアカウント全体の役割で、
-- こちらは「この監視対象に対する役割」。別の軸なので別の型にする。
-- -----------------------------------------------------------------------------
create type member_role as enum (
  'owner',   -- 削除・共有設定・公開ページの発行まで
  'editor',  -- 監視設定の変更まで
  'viewer'   -- 閲覧のみ
);

-- -----------------------------------------------------------------------------
-- monitor_members: 誰がどの監視対象を見られるか
-- -----------------------------------------------------------------------------
create table monitor_members (
  monitor_id uuid not null references monitors (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role member_role not null default 'viewer',
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (monitor_id, user_id)
);

create index monitor_members_user_idx on monitor_members (user_id);

-- 既存の監視対象の所有者を、そのまま owner として登録する。
-- これを忘れると、この migration の直後に全員が自分の監視対象を見られなくなる。
insert into monitor_members (monitor_id, user_id, role)
select m.id, m.owner_id, 'owner' from monitors m;

-- 以降、監視対象を作ったら必ず owner の行も作る。
-- アプリ側で2回 INSERT する形にすると、片方だけ成功した監視対象が生まれうる。
create or replace function add_owner_membership() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into monitor_members (monitor_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict do nothing;
  return new;
end;
$$;

create trigger monitors_add_owner_membership
  after insert on monitors
  for each row execute function add_owner_membership();

-- -----------------------------------------------------------------------------
-- 役割の判定
--
-- **なぜ関数に逃がすのか（重要）**
--   monitors の RLS が monitor_members を参照し、monitor_members の RLS が
--   monitors を参照すると、ポリシーの評価が互いを呼び合って無限再帰する
--   （Postgres は 42P17 で止める）。
--
--   SECURITY DEFINER 関数は定義者の権限で走るため RLS を通過する。
--   判定をこの関数に閉じることで、ポリシーからテーブルを直接引かずに済む。
--
--   その代わり、この関数は「引数で渡された監視対象に対する **auth.uid() の** 役割」
--   しか返さない。任意のユーザーの役割を引ける形にすると、RLS を迂回する道具になる。
-- -----------------------------------------------------------------------------
create or replace function current_member_role(p_monitor_id uuid) returns member_role
language sql
stable
security definer
set search_path = public
as $$
  select mm.role
  from monitor_members mm
  where mm.monitor_id = p_monitor_id
    and mm.user_id = auth.uid();
$$;

create or replace function can_view_monitor(p_monitor_id uuid) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from monitor_members mm
    where mm.monitor_id = p_monitor_id and mm.user_id = auth.uid()
  );
$$;

create or replace function can_edit_monitor(p_monitor_id uuid) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from monitor_members mm
    where mm.monitor_id = p_monitor_id
      and mm.user_id = auth.uid()
      and mm.role in ('owner', 'editor')
  );
$$;

create or replace function is_monitor_owner(p_monitor_id uuid) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from monitor_members mm
    where mm.monitor_id = p_monitor_id
      and mm.user_id = auth.uid()
      and mm.role = 'owner'
  );
$$;

-- -----------------------------------------------------------------------------
-- status_pages: 公開ステータスページ
--
-- 監視対象ごとに1枚。URL に monitors.id を使わず、専用の slug を持たせる。
--
-- **id を使わない理由**
--   - 取り消せない。URL が漏れたときに公開を止める唯一の手段が
--     「監視対象ごと作り直す」になってしまう。slug なら発行し直せる
--   - 内部 ID を外に出すと、他の経路でその ID が意味を持ったときに影響が広がる
-- -----------------------------------------------------------------------------
create table status_pages (
  id uuid primary key default gen_random_uuid(),

  -- 監視対象ごとに1枚（Phase 3 の要件）。
  -- 複数の対象をまとめた1枚が必要になったら中間テーブルに変える。
  monitor_id uuid not null unique references monitors (id) on delete cascade,

  slug text not null unique,

  -- 公開ページに出す名前。監視対象の内部名をそのまま出さない選択ができるようにする
  -- （「StockDesk API（ヘルスチェック）」ではなく「API」と見せたい場合がある）。
  title text not null check (char_length(title) between 1 and 60),
  description text not null default '' check (char_length(description) <= 200),

  -- 取り消しは行の削除ではなくフラグで行う。削除すると slug が失われ、
  -- 「同じ URL で再開する」ができなくなる。
  is_published boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger status_pages_touch_updated_at
  before update on status_pages
  for each row
  when (
    old.title is distinct from new.title or
    old.description is distinct from new.description or
    old.is_published is distinct from new.is_published or
    old.slug is distinct from new.slug
  )
  execute function touch_updated_at();

/**
 * slug の生成。
 *
 * 22文字 × 33種 ≈ 111 ビット。総当たりで当てられる長さではない。
 *
 * 使う文字から l / 1 / 0 / o を外してある。この URL は口頭で伝えたり
 * チャットに貼ったりされるもので、読み違いが起きる文字を含めたくない。
 *
 * get_byte(...) % 33 にはわずかな偏りがあるが（256 は 33 の倍数ではない）、
 * 111 ビットに対して問題になる規模ではないので許容する。
 */
create or replace function generate_status_page_slug(p_length integer default 22) returns text
language plpgsql
volatile
-- gen_random_bytes は pgcrypto の関数で、Supabase では extensions スキーマに入る。
-- 呼び出し元が search_path = public を固定しているため、ここで明示的に足す。
set search_path = public, extensions
as $$
declare
  v_alphabet constant text := 'abcdefghijkmnpqrstuvwxyz23456789';
  v_bytes bytea := gen_random_bytes(p_length);
  v_result text := '';
begin
  for i in 1..p_length loop
    v_result := v_result
      || substr(v_alphabet, (get_byte(v_bytes, i - 1) % length(v_alphabet)) + 1, 1);
  end loop;
  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- 公開ページの発行・再発行
-- -----------------------------------------------------------------------------
create or replace function publish_status_page(
  p_monitor_id uuid,
  p_title text default null,
  p_description text default ''
) returns status_pages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_page status_pages;
  v_title text;
begin
  perform assert_authenticated();

  if not is_monitor_owner(p_monitor_id) then
    -- 「権限がない」ではなく「見つからない」を返す。
    -- 存在の有無そのものを、権限のない相手に教えない。
    raise exception 'MONITOR_NOT_FOUND: 監視対象が見つかりません'
      using errcode = 'P0002';
  end if;

  select coalesce(nullif(trim(p_title), ''), m.name) into v_title
  from monitors m where m.id = p_monitor_id;

  insert into status_pages (monitor_id, slug, title, description)
  values (p_monitor_id, generate_status_page_slug(), v_title, coalesce(p_description, ''))
  on conflict (monitor_id) do update
    set is_published = true,
        title = excluded.title,
        description = excluded.description
  returning * into v_page;

  return v_page;
end;
$$;

/**
 * slug を作り直す。URL が漏れたときの唯一の手当て。
 *
 * 公開を止めるだけ（is_published = false）では、再開したときに同じ URL が生きる。
 * 漏れた URL を無効にしたいなら、slug そのものを変えるほかない。
 */
create or replace function rotate_status_page_slug(p_monitor_id uuid) returns status_pages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_page status_pages;
begin
  perform assert_authenticated();

  if not is_monitor_owner(p_monitor_id) then
    raise exception 'MONITOR_NOT_FOUND: 監視対象が見つかりません' using errcode = 'P0002';
  end if;

  update status_pages
    set slug = generate_status_page_slug()
    where monitor_id = p_monitor_id
    returning * into v_page;

  if not found then
    raise exception 'STATUS_PAGE_NOT_FOUND: 公開ページが発行されていません'
      using errcode = 'P0002';
  end if;

  return v_page;
end;
$$;

create or replace function set_status_page_published(
  p_monitor_id uuid,
  p_is_published boolean
) returns status_pages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_page status_pages;
begin
  perform assert_authenticated();

  if not is_monitor_owner(p_monitor_id) then
    raise exception 'MONITOR_NOT_FOUND: 監視対象が見つかりません' using errcode = 'P0002';
  end if;

  update status_pages
    set is_published = p_is_published
    where monitor_id = p_monitor_id
    returning * into v_page;

  if not found then
    raise exception 'STATUS_PAGE_NOT_FOUND: 公開ページが発行されていません'
      using errcode = 'P0002';
  end if;

  return v_page;
end;
$$;

-- -----------------------------------------------------------------------------
-- public_status: 認証なしで呼べる唯一の入口
--
-- **何を返さないか**が、この関数の設計の中心になる。
--
--   - 監視先の URL を返さない。https://example.com/health?token=... のような
--     経路が設定されうる以上、公開ページに出してよい情報ではない
--   - error_message を返さない。スタックトレースや内部ホスト名が入りうる
--   - status_code を返さない。500 か 503 かは利用者の行動を変えないが、
--     内部構成の手がかりにはなる
--   - 監視対象の内部名を返さない（status_pages.title を使う）
--   - 所有者やメンバーの情報を一切返さない
--
-- 出すのは「今動いているか」「どれだけ止まっていたか」「いつ止まっていたか」だけ。
-- 公開ページを見に来た人が必要とするのはそれで足りる。
--
-- 見つからない場合と公開停止中の場合を区別せず、どちらも null を返す。
-- 区別すると「その slug は存在する」ことを教えてしまう。
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

  -- 集計期間は監視対象の年齢で頭打ちにする（画面側と同じ規則）。
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

    -- 応答時間は出す（速さは利用者の体感そのもの）。ステータスコードは出さない。
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

    -- 障害は「いつ・どれだけ・どの種類か」まで。本文は出さない。
    'incidents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'started_at', i.started_at,
        'ended_at', i.ended_at,
        'cause', i.cause,
        'duration_seconds', extract(epoch from (coalesce(i.ended_at, v_now) - i.started_at))::integer
      ) order by i.started_at desc)
      from (
        select i2.started_at, i2.ended_at, i2.cause
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
-- メンバーの追加・変更・削除
--
-- メールからユーザーを引く必要があるが、auth.users は authenticated から読めない。
-- そのため SECURITY DEFINER 関数に閉じ、入口で所有者であることを確かめる。
--
-- **割り切り**: 招待メールを送る仕組みを持たないので、既に登録済みのユーザーしか
-- 追加できない。USER_NOT_FOUND を返す以上「そのメールが登録済みか」は分かるが、
-- 試せるのはログイン済みのユーザーに限られる。
-- 招待トークン方式（未登録でも招待できる）は必要になった段階で入れる。
-- -----------------------------------------------------------------------------
create or replace function add_monitor_member(
  p_monitor_id uuid,
  p_email text,
  p_role member_role default 'viewer'
) returns monitor_members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := assert_authenticated();
  v_target uuid;
  v_member monitor_members;
begin
  if not is_monitor_owner(p_monitor_id) then
    raise exception 'MONITOR_NOT_FOUND: 監視対象が見つかりません' using errcode = 'P0002';
  end if;

  select id into v_target from auth.users where lower(email) = lower(trim(p_email));

  if v_target is null then
    raise exception 'USER_NOT_FOUND: そのメールアドレスのユーザーは登録されていません'
      using errcode = 'P0002';
  end if;

  insert into monitor_members (monitor_id, user_id, role, invited_by)
  values (p_monitor_id, v_target, p_role, v_uid)
  on conflict (monitor_id, user_id) do update set role = excluded.role
  returning * into v_member;

  return v_member;
end;
$$;

/**
 * 最後の owner を降格・削除できないようにする。
 *
 * owner が1人もいない監視対象は、共有設定も削除も誰にもできない状態になり、
 * 直す手段が DB を直接触ることしか残らない。
 * 「操作できなくなる」種類の事故は、起きてからでは戻せない。
 */
create or replace function assert_not_last_owner(p_monitor_id uuid, p_user_id uuid) returns void
language plpgsql
stable
set search_path = public
as $$
begin
  if exists (
    select 1 from monitor_members
    where monitor_id = p_monitor_id and user_id = p_user_id and role = 'owner'
  ) and (
    select count(*) from monitor_members
    where monitor_id = p_monitor_id and role = 'owner'
  ) <= 1 then
    raise exception 'LAST_OWNER: 最後の所有者は変更・削除できません'
      using errcode = '23514';
  end if;
end;
$$;

create or replace function set_monitor_member_role(
  p_monitor_id uuid,
  p_user_id uuid,
  p_role member_role
) returns monitor_members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member monitor_members;
begin
  perform assert_authenticated();

  if not is_monitor_owner(p_monitor_id) then
    raise exception 'MONITOR_NOT_FOUND: 監視対象が見つかりません' using errcode = 'P0002';
  end if;

  if p_role <> 'owner' then
    perform assert_not_last_owner(p_monitor_id, p_user_id);
  end if;

  update monitor_members
    set role = p_role
    where monitor_id = p_monitor_id and user_id = p_user_id
    returning * into v_member;

  if not found then
    raise exception 'MEMBER_NOT_FOUND: そのメンバーは登録されていません'
      using errcode = 'P0002';
  end if;

  return v_member;
end;
$$;

create or replace function remove_monitor_member(
  p_monitor_id uuid,
  p_user_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := assert_authenticated();
begin
  -- 自分で抜けるのは所有者でなくても許す（共有された側が縁を切れないのは不便）。
  if not is_monitor_owner(p_monitor_id) and p_user_id <> v_uid then
    raise exception 'MONITOR_NOT_FOUND: 監視対象が見つかりません' using errcode = 'P0002';
  end if;

  perform assert_not_last_owner(p_monitor_id, p_user_id);

  delete from monitor_members
    where monitor_id = p_monitor_id and user_id = p_user_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- メンバー一覧（メールを見せるため関数にする）
--
-- auth.users を authenticated に開くわけにはいかないので、
-- 「自分が見られる監視対象の、メンバーのメールだけ」を返す関数を用意する。
-- -----------------------------------------------------------------------------
create or replace function monitor_members_of(p_monitor_id uuid)
returns table (
  user_id uuid,
  email text,
  display_name text,
  role member_role,
  created_at timestamptz,
  is_self boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform assert_authenticated();

  if not can_view_monitor(p_monitor_id) then
    raise exception 'MONITOR_NOT_FOUND: 監視対象が見つかりません' using errcode = 'P0002';
  end if;

  return query
    select
      mm.user_id,
      u.email::text,
      coalesce(nullif(p.display_name, ''), split_part(u.email::text, '@', 1)) as display_name,
      mm.role,
      mm.created_at,
      mm.user_id = auth.uid() as is_self
    from monitor_members mm
    join auth.users u on u.id = mm.user_id
    left join profiles p on p.id = mm.user_id
    where mm.monitor_id = p_monitor_id
    order by mm.role, mm.created_at;
end;
$$;

-- =============================================================================
-- RLS の張り替え
--
-- Phase 1 の「所有者だけ」を「メンバーなら閲覧、editor 以上なら変更、
-- owner だけが削除と共有設定」に置き換える。
-- =============================================================================

drop policy monitors_select on monitors;
drop policy monitors_insert on monitors;
drop policy monitors_update on monitors;
drop policy monitors_delete on monitors;
drop policy checks_select on checks;
drop policy incidents_select on incidents;
drop policy notifications_select on notifications;

create policy monitors_select on monitors
  for select to authenticated
  using (can_view_monitor(id));

-- 作成時だけは owner_id を直接見る。まだ monitor_members の行が無いため。
create policy monitors_insert on monitors
  for insert to authenticated
  with check (owner_id = auth.uid());

create policy monitors_update on monitors
  for update to authenticated
  using (can_edit_monitor(id))
  with check (can_edit_monitor(id));

-- 削除は owner だけ。editor に消させない。
-- 監視対象の削除はチェック履歴とダウンタイムの記録を巻き添えにするため、
-- 設定変更と同じ重さの操作として扱わない。
create policy monitors_delete on monitors
  for delete to authenticated
  using (is_monitor_owner(id));

create policy checks_select on checks
  for select to authenticated
  using (can_view_monitor(monitor_id));

create policy incidents_select on incidents
  for select to authenticated
  using (can_view_monitor(monitor_id));

create policy notifications_select on notifications
  for select to authenticated
  using (can_view_monitor(monitor_id));

-- monitor_members: 同じ監視対象のメンバーは互いに見える。
-- 書き換えは関数経由のみ（ポリシーを作らないことで塞ぐ）。
alter table monitor_members enable row level security;

create policy monitor_members_select on monitor_members
  for select to authenticated
  using (can_view_monitor(monitor_id));

-- status_pages: メンバーは見える。発行・取り消しは関数経由（owner のみ）。
alter table status_pages enable row level security;

create policy status_pages_select on status_pages
  for select to authenticated
  using (can_view_monitor(monitor_id));

-- -----------------------------------------------------------------------------
-- 権限
-- -----------------------------------------------------------------------------
revoke all on monitor_members from anon, authenticated;
grant select on monitor_members to authenticated;

revoke all on status_pages from anon, authenticated;
grant select on status_pages to authenticated;

-- 判定用のヘルパは SECURITY DEFINER なので、呼び出せる相手を絞る。
-- 引数の監視対象に対する auth.uid() の役割しか返さないが、
-- anon から呼べる必要はまったく無い。
revoke execute on function current_member_role(uuid) from public, anon;
revoke execute on function can_view_monitor(uuid) from public, anon;
revoke execute on function can_edit_monitor(uuid) from public, anon;
revoke execute on function is_monitor_owner(uuid) from public, anon;
revoke execute on function add_owner_membership() from public, anon, authenticated;
revoke execute on function generate_status_page_slug(integer) from public, anon, authenticated;
revoke execute on function assert_not_last_owner(uuid, uuid) from public, anon;

revoke execute on function publish_status_page(uuid, text, text) from public, anon;
revoke execute on function rotate_status_page_slug(uuid) from public, anon;
revoke execute on function set_status_page_published(uuid, boolean) from public, anon;
revoke execute on function add_monitor_member(uuid, text, member_role) from public, anon;
revoke execute on function set_monitor_member_role(uuid, uuid, member_role) from public, anon;
revoke execute on function remove_monitor_member(uuid, uuid) from public, anon;
revoke execute on function monitor_members_of(uuid) from public, anon;

grant execute on function publish_status_page(uuid, text, text) to authenticated;
grant execute on function rotate_status_page_slug(uuid) to authenticated;
grant execute on function set_status_page_published(uuid, boolean) to authenticated;
grant execute on function add_monitor_member(uuid, text, member_role) to authenticated;
grant execute on function set_monitor_member_role(uuid, uuid, member_role) to authenticated;
grant execute on function remove_monitor_member(uuid, uuid) to authenticated;
grant execute on function monitor_members_of(uuid) to authenticated;

-- **anon に開く唯一の関数。**
-- テーブルは1つも開かない。slug を知らなければ何も返らない。
revoke execute on function public_status(text, integer) from public;
grant execute on function public_status(text, integer) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- monitor_overview に、画面が必要とする2つを足す
--   - viewer_role     — 押せないボタンを描かないため（防御は RLS 側）
--   - status_page_*   — 公開ページの発行状況
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
