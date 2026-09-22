-- =============================================================================
-- StatusPulse / Phase 1 スキーマ
--
-- 設計の骨子（詳細は docs/schema.md）:
--   1. 「観測」と「判定」を別の場所に持つ。
--      checks が観測（1回のリクエストの事実）、monitors.current_status が判定（解釈）。
--      判定の規則は誤検知対策で変わりうるが、観測は事実なので後から書き換えない。
--   2. checks は追記専用で、アプリからは直接書けない。書き込み経路は record_check() のみ。
--   3. 稼働率の集計は最初から DB 側（monitor_overview ビュー）に置く。
--      7日ぶんのチェックは1対象で1万行を超えるため、ブラウザに運んで数えることはできない。
-- =============================================================================

-- gen_random_uuid() 用。Supabase では既定で有効だが、明示しておく。
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- enum 型
-- 取りうる値が業務上固定で、型名そのものがドメイン語彙になるものは enum にする。
-- TypeScript 側の対応表は packages/core/src/monitor.ts。値の並びを一致させてある。
-- -----------------------------------------------------------------------------

-- Phase 3 のチーム機能の受け皿。Phase 1 では参照しない。
create type user_role as enum ('owner', 'member');

-- 監視対象の「判定」。unknown は「まだ確かめていない」であって「落ちている」ではない。
-- 登録直後の対象を down と表示しないために、この3値目を持つ。
create type monitor_status as enum ('unknown', 'up', 'down');

-- 1回のチェックの「観測」。ここに unknown は無い。チェックした以上、結果は出ている。
create type check_result as enum ('up', 'down');

-- 失敗の種類。「落ちている」と一口に言っても、名前が引けないのと 500 が返るのとでは
-- 打つ手が違う。自由記述の error_message とは別に、集計可能な分類を必ず持たせる。
create type check_error_kind as enum (
  'timeout',  -- 制限時間内に応答がなかった
  'dns',      -- 名前解決に失敗した
  'tls',      -- 証明書の検証に失敗した
  'network',  -- 接続そのものが確立できなかった
  'status',   -- 応答は返ったが、期待するステータスコードではなかった
  'unknown'   -- 上記に分類できなかった
);

-- 監視で使うメソッド。POST などを許さないのは、監視が対象の状態を変えてはならないため。
create type http_method as enum ('GET', 'HEAD');

-- -----------------------------------------------------------------------------
-- profiles: auth.users の拡張
-- Phase 3 のチーム機能（複数ユーザーで同じ監視対象を見る）の受け皿を先に作っておく。
-- Phase 1 では role を参照せず、監視対象は owner_id による所有で分離する。
-- -----------------------------------------------------------------------------
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  role user_role not null default 'member',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- monitors: 監視対象
-- -----------------------------------------------------------------------------
create table monitors (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,

  name text not null check (char_length(name) between 1 and 60),

  -- URL の検証は packages/core/src/url.ts（localhost や私有 IP を弾く）が本体。
  -- ここではスキームだけを DB 側の最低限の防御として持つ。
  url text not null check (url ~* '^https?://'),

  method http_method not null default 'GET',

  -- NULL なら 2xx / 3xx を正常とみなす。
  -- 「301 が返ること自体を確かめたい」場合に明示できるよう、値を持てるようにしてある。
  expected_status_code integer check (expected_status_code between 100 and 599),

  -- 自由な値を許さない。Cron は1分ごとにしか起動しないので、
  -- それより短い間隔は「設定できるが守られない」設定になってしまう。
  interval_seconds integer not null default 300
    check (interval_seconds in (60, 300, 900, 1800, 3600)),

  timeout_ms integer not null default 10000 check (timeout_ms between 1000 and 30000),

  is_enabled boolean not null default true,

  -- --- ここから下は「判定」のキャッシュ。record_check() 以外から更新しない ---
  -- 列単位の GRANT で、アプリからの直接 UPDATE を塞いである（0003_rls.sql）。

  current_status monitor_status not null default 'unknown',

  -- 連続して失敗した回数。成功したら 0 に戻る。
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),

  -- 何回連続で失敗したら down と判定するか。
  -- Phase 1 は 1（1回の失敗で異常）。Phase 2 で誤検知対策としてこの値を上げる。
  -- 判定ロジックは閾値を引数に取る形で先に書いてあるので、Phase 2 での変更は値だけになる。
  failure_threshold integer not null default 1 check (failure_threshold between 1 and 10),

  -- 次のチェック時刻の判定に使う。チェックを試みた時刻であり、成功した時刻ではない。
  last_checked_at timestamptz,

  -- current_status が最後に変わった時刻。「3時間ダウン中」の表示に使う。
  status_changed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 同じ URL を同じ人が二重に登録しても、相手への負荷が倍になるだけで得るものが無い。
-- URL は core 側で正規化してから入るので、末尾スラッシュ違いの重複は起きない。
create unique index monitors_owner_url_key on monitors (owner_id, url);

-- due 判定（定期処理が毎分引くクエリ）専用の部分索引。
-- 無効化された対象は永久に対象外なので、索引にも載せない。
create index monitors_due_idx on monitors (last_checked_at nulls first) where is_enabled;

create index monitors_owner_idx on monitors (owner_id);

-- -----------------------------------------------------------------------------
-- checks: チェック結果（追記専用の観測ログ）
--
-- id を uuid にしていない理由:
--   このテーブルは 1対象 1分間隔で 1日 1440 行、7日で1万行を超える。
--   uuid は 16 バイトでランダムな順序に挿入されるため、索引の断片化を招く。
--   時系列に追記されるログに対して、単調増加する bigint の方が構造的に合う。
--   外部に露出する識別子でもないので、推測されにくさは要件にならない。
-- -----------------------------------------------------------------------------
create table checks (
  id bigint generated always as identity primary key,
  monitor_id uuid not null references monitors (id) on delete cascade,

  -- チェックを「実行した」時刻。稼働率の集計はこの列で期間を切る。
  checked_at timestamptz not null default now(),

  result check_result not null,

  status_code integer check (status_code between 100 and 599),

  -- 応答が返らなかった場合は NULL。
  -- 接続できずに費やした時間を応答時間として平均に混ぜると、
  -- 障害中に応答が速くなったように見えてしまう。
  response_time_ms integer check (response_time_ms >= 0),

  error_kind check_error_kind,
  error_message text,

  -- 観測と分類の整合。成功に失敗理由が付いている行、
  -- 失敗なのに理由が無い行は、後から読んだときに意味が取れない。
  constraint checks_error_kind_matches_result check (
    (result = 'up' and error_kind is null) or
    (result = 'down' and error_kind is not null)
  )
);

-- 稼働率の集計も、直近の履歴表示も、すべて「対象ごとに新しい順」で引く。
-- この1本で両方をカバーする。
create index checks_monitor_checked_idx on checks (monitor_id, checked_at desc);

-- -----------------------------------------------------------------------------
-- 共通トリガ
-- -----------------------------------------------------------------------------
create or replace function touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
  before update on profiles
  for each row execute function touch_updated_at();

-- monitors の updated_at は「設定が変更された時刻」であって、チェックの時刻ではない。
-- record_check() は毎分 monitors を更新するので、無条件に now() を入れると
-- updated_at がチェック時刻と同義になり、列として意味を失う。
-- （チェックの時刻は last_checked_at が持っている）
-- そこで、人が変更しうる列が実際に変わったときだけ更新する。
create trigger monitors_touch_updated_at
  before update on monitors
  for each row
  when (
    old.name is distinct from new.name or
    old.url is distinct from new.url or
    old.method is distinct from new.method or
    old.expected_status_code is distinct from new.expected_status_code or
    old.interval_seconds is distinct from new.interval_seconds or
    old.timeout_ms is distinct from new.timeout_ms or
    old.is_enabled is distinct from new.is_enabled or
    old.failure_threshold is distinct from new.failure_threshold
  )
  execute function touch_updated_at();

-- -----------------------------------------------------------------------------
-- サインアップ時に profiles を作る
--
-- 最初の1人を owner にするのは Phase 3 のチーム機能を見据えたもの。
-- 自分のサービスを監視するために自分で立てたツール、という前提に合わせている。
-- -----------------------------------------------------------------------------
create or replace function handle_new_user() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, display_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)),
    case when (select count(*) from profiles) = 0 then 'owner'::user_role else 'member'::user_role end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
