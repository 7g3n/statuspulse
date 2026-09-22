-- =============================================================================
-- ローカル開発用のシードデータ（`supabase db reset` で流れる）
--
-- 7日ぶんのチェック履歴を生成する。数時間ぶんのデータでは
--   - 7日間の稼働率が24時間の稼働率と同じ値になり、2つ並べる意味が見えない
--   - 障害と復旧が1件も含まれず、色分けが常に緑のままになる
-- となって、作った機能を確かめられない。
-- 開発用データは「機能を実演できるだけの期間と量」を持っている必要がある。
--
-- 生成は乱数を使わず、監視対象 ID と時刻のハッシュから決定的に決まるようにしてある。
-- 毎回同じデータになる方が、画面の見え方やスクリーンショットの前提が安定する。
--
-- ※ 監視対象の1つ目は StockDesk のデプロイ先。URL は差し替え用のプレースホルダなので、
--    実際のデプロイ先に置き換えて使う（下の該当行を参照）。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- デモ用のユーザー
--
-- ログイン: demo@statuspulse.test / demo-password
--
-- auth.users へ直接 INSERT しているのは、シードは psql から postgres ロールで走り、
-- Auth の HTTP API を経由できないため。identities も作らないとメールでログインできない。
-- profiles は on_auth_user_created トリガが自動で作る（最初の1人なので owner になる）。
-- -----------------------------------------------------------------------------
-- トークン列（confirmation_token など）を NULL のままにしないこと。
-- GoTrue はこれらを Go の string として読むため、NULL が入っていると
-- ログイン時に 500（converting NULL to string is unsupported）で落ちる。
-- 画面からサインアップした場合は GoTrue 自身が空文字を入れるので、
-- 手で INSERT するこのシードだけが踏む。
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  confirmation_token, recovery_token, email_change, email_change_token_new, email_change_token_current
) values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-0000000000a1',
  'authenticated',
  'authenticated',
  'demo@statuspulse.test',
  crypt('demo-password', gen_salt('bf')),
  now(), now() - interval '30 days', now(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"デモユーザー"}',
  '', '', '', '', ''
);

insert into auth.identities (
  provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
) values (
  '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000a1',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","email":"demo@statuspulse.test","email_verified":true}',
  'email',
  now(), now() - interval '30 days', now()
);

-- -----------------------------------------------------------------------------
-- 監視対象
--
-- 稼働率・色分け・応答時間の差が画面上で見分けられるよう、性格の違うものを並べてある。
--   - 常時正常なもの（稼働率 100%）
--   - 短い障害が数回あったもの（99% 台）
--   - 今まさに落ちているもの
--   - 一時的に無効化してあるもの
-- -----------------------------------------------------------------------------
-- 1つ目だけ failure_threshold を 3 にしてある。
-- 5日前の32分の障害はインシデントとして記録されるが、2日前の10分の瞬断
-- （5分間隔なので2回）は閾値に届かず記録されない。
-- 「誤検知を減らす」設定が実際に何を落とすのかを、画面で見比べられるようにするため。
insert into monitors (
  id, owner_id, name, url, method, expected_status_code,
  interval_seconds, timeout_ms, failure_threshold, is_enabled, created_at
) values
  -- ★ 自分のデプロイ先に差し替える行 ★
  (
    '00000000-0000-0000-0000-0000000000b1',
    '00000000-0000-0000-0000-0000000000a1',
    'StockDesk（本番）',
    'https://stockdesk.example.com/',
    'GET', null, 300, 10000, 3, true, now() - interval '30 days'
  ),
  (
    '00000000-0000-0000-0000-0000000000b2',
    '00000000-0000-0000-0000-0000000000a1',
    'StockDesk API（ヘルスチェック）',
    'https://stockdesk.example.com/api/health',
    'GET', 200, 300, 5000, 2, true, now() - interval '30 days'
  ),
  (
    '00000000-0000-0000-0000-0000000000b3',
    '00000000-0000-0000-0000-0000000000a1',
    'ポートフォリオサイト',
    'https://portfolio.example.com/',
    'HEAD', null, 900, 10000, 2, true, now() - interval '30 days'
  ),
  (
    '00000000-0000-0000-0000-0000000000b4',
    '00000000-0000-0000-0000-0000000000a1',
    '画像配信 CDN',
    'https://cdn.example.com/health.txt',
    'GET', 200, 300, 3000, 2, true, now() - interval '30 days'
  ),
  (
    '00000000-0000-0000-0000-0000000000b5',
    '00000000-0000-0000-0000-0000000000a1',
    '検証環境（stg）',
    'https://stg.stockdesk.example.com/',
    'GET', null, 1800, 10000, 2, false, now() - interval '30 days'
  );

-- -----------------------------------------------------------------------------
-- チェック履歴の生成（直近7日ぶん）
--
-- 障害の時間帯を明示的な表で与え、その範囲に入るチェックだけを失敗にする。
-- 「何％失敗させる」という確率的な作り方をしないのは、そうすると失敗が期間全体に
-- ばらけてしまい、実際の障害（ある時間帯にまとまって落ちる）と見え方が変わるため。
-- Phase 2 のダウンタイム履歴を実装したときに、まとまりが無いと機能を確かめられない。
-- -----------------------------------------------------------------------------
with incidents (monitor_id, started_at, ended_at, error_kind, status_code, message) as (
  values
    -- StockDesk 本番: 5日前の深夜に 32 分（デプロイ失敗の想定）
    (
      '00000000-0000-0000-0000-0000000000b1'::uuid,
      now() - interval '5 days' - interval '2 hours',
      now() - interval '5 days' - interval '88 minutes',
      'status'::check_error_kind, 502, 'HTTP 502 が返りました'
    ),
    -- StockDesk 本番: 2日前に 10 分（上流の一時的な不調）
    (
      '00000000-0000-0000-0000-0000000000b1'::uuid,
      now() - interval '2 days',
      now() - interval '2 days' + interval '10 minutes',
      'timeout'::check_error_kind, null, '10000ms 以内に応答がありませんでした'
    ),
    -- API: 本番と同じ 5 日前の障害に巻き込まれている（同じ実体を監視しているため）
    (
      '00000000-0000-0000-0000-0000000000b2'::uuid,
      now() - interval '5 days' - interval '2 hours',
      now() - interval '5 days' - interval '80 minutes',
      'status'::check_error_kind, 503, 'HTTP 503 が返りました（期待: 200）'
    ),
    -- CDN: 現在も継続中の障害。ダッシュボードで「異常」を見せるため終了時刻を未来にする
    (
      '00000000-0000-0000-0000-0000000000b4'::uuid,
      now() - interval '38 minutes',
      now() + interval '1 day',
      'dns'::check_error_kind, null, '名前解決に失敗しました'
    )
    -- ポートフォリオサイト（b3）には障害を入れない。稼働率 100% の見え方を確かめるため。
)
insert into checks (monitor_id, checked_at, result, status_code, response_time_ms, error_kind, error_message)
select
  m.id,
  ts,
  case when i.monitor_id is null then 'up' else 'down' end::check_result,

  -- 失敗時のステータスコード。接続前に失敗した場合（timeout / dns）は NULL のまま。
  case when i.monitor_id is null then 200 else i.status_code end,

  -- 応答時間。対象ごとの基準値に、ID と時刻から決まるゆらぎを足す。
  -- 応答が返らなかったチェックは NULL（接続できずに費やした時間は応答時間ではない）。
  case
    when i.monitor_id is not null and i.status_code is null then null
    else (
      case m.id
        when '00000000-0000-0000-0000-0000000000b1'::uuid then 180
        when '00000000-0000-0000-0000-0000000000b2'::uuid then 90
        when '00000000-0000-0000-0000-0000000000b3'::uuid then 45
        when '00000000-0000-0000-0000-0000000000b4'::uuid then 60
        else 210
      end
      + mod(abs(hashtextextended(m.id::text || ts::text, 0)), 70)
    )::integer
  end,

  i.error_kind,
  i.message
from monitors m
-- 時刻は間隔の境界に合わせる。now() で打ち切ると全対象の最終チェックが揃って
-- 「0秒前」になり、実際の動き（対象ごとに間隔で順番に回る）と見え方が変わる。
cross join lateral (
  select to_timestamp(
    floor(extract(epoch from now()) / m.interval_seconds) * m.interval_seconds
  ) as latest_at
) b
cross join lateral generate_series(
  b.latest_at - interval '7 days',
  b.latest_at,
  make_interval(secs => m.interval_seconds)
) as ts
left join incidents i
  on i.monitor_id = m.id
 and ts >= i.started_at
 and ts < i.ended_at
-- 無効化された対象（stg）は、無効にする前の履歴だけを持っている状態にする。
where m.is_enabled or ts < now() - interval '3 days';

-- -----------------------------------------------------------------------------
-- 判定のキャッシュを履歴から復元する
--
-- 本来この3列は record_check() だけが更新する。シードは checks を直接作っているので、
-- 生成した履歴と辻褄が合う値をここで入れておく。
-- （逆に言えば、この2つがずれていないことがキャッシュの正しさの検査にもなる）
-- -----------------------------------------------------------------------------
with ranked as (
  select
    monitor_id,
    result,
    checked_at,
    row_number() over (partition by monitor_id order by checked_at desc) as rn
  from checks
),
latest as (
  select monitor_id, result, checked_at from ranked where rn = 1
),
-- 末尾に連続している失敗の数 = 新しい方から数えて最初に成功が現れる位置 - 1
trailing_failures as (
  select
    l.monitor_id,
    coalesce(
      (select min(r.rn) from ranked r where r.monitor_id = l.monitor_id and r.result = 'up'),
      (select count(*) + 1 from ranked r where r.monitor_id = l.monitor_id)
    ) - 1 as failures
  from latest l
),
-- 現在の状態が始まった時刻 = 直前の異なる結果より後で、最も古い同じ結果の時刻
status_changed as (
  select
    l.monitor_id,
    min(c.checked_at) as changed_at
  from latest l
  join checks c on c.monitor_id = l.monitor_id and c.result = l.result
  where c.checked_at > coalesce(
    (select max(c2.checked_at) from checks c2
      where c2.monitor_id = l.monitor_id and c2.result <> l.result),
    '-infinity'::timestamptz
  )
  group by l.monitor_id
)
update monitors m set
  last_checked_at = l.checked_at,
  -- 閾値に届いていない失敗は down にしない（record_check() と同じ規則）。
  -- シードの対象はいずれも履歴の中で一度は成功しているので、down でなければ up になる。
  current_status = (
    case when l.result = 'down' and tf.failures >= m.failure_threshold then 'down' else 'up' end
  )::monitor_status,
  consecutive_failures = case when l.result = 'up' then 0 else tf.failures end,
  first_failure_at = case when l.result = 'up' then null else ff.at end,
  status_changed_at = sc.changed_at
from latest l
join trailing_failures tf on tf.monitor_id = l.monitor_id
join status_changed sc on sc.monitor_id = l.monitor_id
left join lateral (
  -- 末尾に続いている失敗の、最初の1回の時刻
  select min(c.checked_at) as at
  from checks c
  where c.monitor_id = l.monitor_id
    and c.result = 'down'
    and c.checked_at > coalesce(
      (select max(c2.checked_at) from checks c2
        where c2.monitor_id = l.monitor_id and c2.result = 'up'),
      '-infinity'::timestamptz
    )
) ff on true
where m.id = l.monitor_id;

-- -----------------------------------------------------------------------------
-- 生成した履歴からインシデントを復元する
--
-- 本来 incidents は record_check() が開閉する。シードは checks を直接作っているので、
-- 同じ規則（連続した失敗のまとまり / 閾値に届いたものだけ / 開始は最初の失敗）を
-- ここで再現する。
--
-- 連続したまとまりの取り出しは、並び順の差が一定になることを使う（gaps and islands）。
-- 全体の連番と、結果ごとの連番の差は、同じ結果が続いている間だけ一定になる。
-- -----------------------------------------------------------------------------
with ordered as (
  select
    c.monitor_id, c.checked_at, c.result, c.error_kind, c.status_code, c.error_message,
    row_number() over (partition by c.monitor_id order by c.checked_at)
      - row_number() over (partition by c.monitor_id, c.result order by c.checked_at) as run_id
  from checks c
),
down_runs as (
  select
    o.monitor_id,
    min(o.checked_at) as started_at,
    max(o.checked_at) as last_failure_at,
    count(*)::integer as failure_count,
    (array_agg(o.error_kind order by o.checked_at))[1] as cause,
    (array_agg(o.status_code order by o.checked_at))[1] as status_code,
    (array_agg(o.error_message order by o.checked_at))[1] as error_message
  from ordered o
  where o.result = 'down'
  group by o.monitor_id, o.run_id
)
insert into incidents (
  monitor_id, started_at, ended_at, cause, status_code, error_message, failure_count
)
select
  r.monitor_id,
  -- 開始は「最初に失敗した時刻」。閾値ぶんの遅れを稼働率に持ち込まない。
  r.started_at,
  -- 復旧は「成功を確認した時刻」。次の成功が無ければ継続中（NULL）。
  (
    select min(c.checked_at) from checks c
    where c.monitor_id = r.monitor_id
      and c.result = 'up'
      and c.checked_at > r.last_failure_at
  ),
  r.cause,
  r.status_code,
  r.error_message,
  r.failure_count
from down_runs r
join monitors m on m.id = r.monitor_id
where r.failure_count >= m.failure_threshold;

-- -----------------------------------------------------------------------------
-- 通知の記録
--
-- 実際には Worker が claim_notification() で作る。画面に「通知済み / 未送信」の
-- 見え方を出すため、シードでは送信済みとして入れておく。
-- -----------------------------------------------------------------------------
insert into notifications (kind, dedupe_key, monitor_id, incident_id, payload, status, claimed_at, settled_at)
select
  'monitor_down',
  'monitor_down:' || i.id,
  i.monitor_id,
  i.id,
  jsonb_build_object('monitor_name', m.name, 'url', m.url, 'event', 'went_down'),
  'sent',
  i.started_at,
  i.started_at
from incidents i
join monitors m on m.id = i.monitor_id;

insert into notifications (kind, dedupe_key, monitor_id, incident_id, payload, status, claimed_at, settled_at)
select
  'monitor_recovered',
  'monitor_recovered:' || i.id,
  i.monitor_id,
  i.id,
  jsonb_build_object('monitor_name', m.name, 'url', m.url, 'event', 'recovered'),
  'sent',
  i.ended_at,
  i.ended_at
from incidents i
join monitors m on m.id = i.monitor_id
where i.ended_at is not null;
