# スキーマ設計

対象: `supabase/migrations/` 配下のマイグレーション。

## ER の概要

```
auth.users ──1:1── profiles
     │
     └──1:N── monitors ──1:N── checks
                                （チェック結果の追記専用ログ）
```

テーブルは3つしかないが、設計の中心は列の分け方にある。
`monitors` は**設定**と**判定のキャッシュ**という性格の違う列を持ち、書き込み経路が別になっている。

---

## テーブル

### profiles

`auth.users` の拡張。Phase 3 のチーム機能の受け皿として先に用意してある。

| 列             | 型        | 備考                                            |
| -------------- | --------- | ----------------------------------------------- |
| `id`           | uuid PK   | `auth.users(id)` を参照。ユーザー削除で連動削除 |
| `display_name` | text      | 未設定ならメールのローカル部を使う              |
| `role`         | user_role | `owner` / `member`                              |

サインアップ時にトリガ `handle_new_user()` が自動で作成する。**最初の1人が owner**、以降は member。自分のサービスを監視するために自分で立てたツール、という前提に合わせている。

Phase 1 では `role` を参照しない。分離の単位は `monitors.owner_id` による所有。チームでの共有は Phase 3 で RLS を張り替えて入れる。

### monitors

監視対象。列は性格で2つに分かれる。

**設定（利用者が変更できる）**

| 列                     | 型          | 備考                                                 |
| ---------------------- | ----------- | ---------------------------------------------------- |
| `owner_id`             | uuid        | `auth.users(id)`。RLS の分離キー                     |
| `name`                 | text        | 1〜60文字                                            |
| `url`                  | text        | `^https?://` の CHECK。詳細な検証は `core/url.ts`    |
| `method`               | http_method | `GET` / `HEAD`                                       |
| `expected_status_code` | integer     | NULL なら 2xx / 3xx を正常とみなす                   |
| `interval_seconds`     | integer     | 60 / 300 / 900 / 1800 / 3600 のいずれか              |
| `timeout_ms`           | integer     | 1000〜30000                                          |
| `is_enabled`           | boolean     | 無効にするとチェック対象から外れる（履歴は残る）     |
| `failure_threshold`    | integer     | 何回連続で失敗したら down とするか。Phase 1 は既定 1 |

**判定のキャッシュ（`record_check()` だけが更新する）**

| 列                     | 型             | 備考                                  |
| ---------------------- | -------------- | ------------------------------------- |
| `current_status`       | monitor_status | `unknown` / `up` / `down`             |
| `consecutive_failures` | integer        | 連続失敗回数。成功で 0 に戻る         |
| `last_checked_at`      | timestamptz    | **試みた**時刻。成功した時刻ではない  |
| `status_changed_at`    | timestamptz    | `current_status` が最後に変わった時刻 |

後者はアプリから UPDATE できない。列単位の GRANT で `authenticated` から外してある（後述）。

**`unknown` を持つ理由**: 登録直後の対象を `down` と表示しないため。「まだ確かめていない」と「確かめたら落ちていた」は別の事実で、前者を赤で出すと、URL を打ち間違えた場合と本当に落ちている場合の区別がつかない。

**`last_checked_at` を成否にかかわらず更新する理由**: 失敗時に更新しないと、落ちている対象だけが毎分チェックされ続ける。最も負荷をかけたくない相手に、最も多くリクエストを送ることになる。

**索引**

```sql
create unique index monitors_owner_url_key on monitors (owner_id, url);
create index monitors_due_idx on monitors (last_checked_at nulls first) where is_enabled;
create index monitors_owner_idx on monitors (owner_id);
```

`monitors_due_idx` は定期処理が毎分引くクエリ専用。無効化された対象は永久に対象外なので、部分索引にして載せない。

URL の一意制約は `owner_id` との複合。同じ URL を同じ人が二重に登録しても、相手への負荷が倍になり、稼働率が2つに割れるだけで得るものが無い。URL は書き込み前に `normalizeMonitorValues()` で正規化されるので、末尾スラッシュ違いの重複は起きない。

### checks

チェック結果の追記専用ログ。**観測そのもの**であり、判定は含まない。

| 列                 | 型               | 備考                                                         |
| ------------------ | ---------------- | ------------------------------------------------------------ |
| `id`               | bigint identity  | 時系列に追記されるログなので uuid を使わない                 |
| `monitor_id`       | uuid             | 対象削除で連動削除                                           |
| `checked_at`       | timestamptz      | 稼働率の集計はこの列で期間を切る                             |
| `result`           | check_result     | `up` / `down`（`unknown` は無い）                            |
| `status_code`      | integer          | 接続前に失敗した場合は NULL                                  |
| `response_time_ms` | integer          | 応答が返らなかった場合は NULL                                |
| `error_kind`       | check_error_kind | `timeout` / `dns` / `tls` / `network` / `status` / `unknown` |
| `error_message`    | text             | 分類できなかった原因も含めて残す                             |

```sql
create index checks_monitor_checked_idx on checks (monitor_id, checked_at desc);
```

稼働率の集計も、履歴の表示も、直近チェックの帯も、すべて「対象ごとに新しい順」で引く。この1本で足りる。

**`response_time_ms` を失敗時に NULL にする理由**: 接続できずに費やした時間を応答時間として平均に混ぜると、**障害中に平均応答時間が改善したように見える**。一方、ステータス異常（500 が返った等）では応答は返っているので値を残す。「500 を返すが速い」と「応答自体が遅い」は別の障害で、切り分けには両方の記録が要る。

**整合の CHECK**

```sql
constraint checks_error_kind_matches_result check (
  (result = 'up' and error_kind is null) or
  (result = 'down' and error_kind is not null)
)
```

成功に失敗理由が付いている行、失敗なのに理由が無い行は、後から読んだときに意味が取れない。

---

## enum

| 型                 | 値                                                           |
| ------------------ | ------------------------------------------------------------ |
| `user_role`        | `owner` / `member`                                           |
| `monitor_status`   | `unknown` / `up` / `down`                                    |
| `check_result`     | `up` / `down`                                                |
| `check_error_kind` | `timeout` / `dns` / `tls` / `network` / `status` / `unknown` |
| `http_method`      | `GET` / `HEAD`                                               |

TypeScript 側の対応表は `packages/core/src/monitor.ts`。値の並びを一致させてある。

`http_method` に POST を含めないのは、**監視が対象の状態を変えてはならない**ため。

---

## 不変条件

1. `monitors.current_status` は、その対象の `checks` を古い順に `nextMonitorState()` へ通した結果と一致する
2. `monitors.consecutive_failures` は、末尾に連続する `result = 'down'` の数と一致する（直前が成功なら 0）
3. `monitors.last_checked_at` は、その対象の `checks.checked_at` の最大値と一致する

いずれも `record_check()` が単独の書き込み経路であることによって保たれる。突合は次のクエリで確認できる。

```sql
select m.id, m.name, m.last_checked_at, max(c.checked_at) as latest_check
from monitors m
left join checks c on c.monitor_id = m.id
group by m.id, m.name, m.last_checked_at
having m.last_checked_at is distinct from max(c.checked_at);
```

---

## RPC 関数

### record_check(monitor_id, result, status_code, response_time_ms, error_kind, error_message)

チェック結果を記録する唯一の入口。SECURITY DEFINER。**service_role のみ実行可**。

1. 対象行を `for update` でロック
2. `checks` に1行追記（観測を先に確定させる）
3. 判定を進めて `monitors` を更新

戻り値は `jsonb`。

```json
{
  "monitor_id": "…",
  "previous_status": "up",
  "status": "down",
  "consecutive_failures": 1,
  "event": "went_down"
}
```

`event` は `went_down` / `recovered` / `null`。Phase 2 のダウンタイム記録と Slack 通知はこれを起点にする。呼び出し側に「前回の状態と比べる」処理を持たせないための戻り値。

行ロックにより、Cron が二重起動しても `consecutive_failures` が競合して壊れることはない。

### due_monitors(tolerance_seconds = 30, limit = 200)

今チェックすべき対象を `last_checked_at` の古い順に返す。SECURITY DEFINER。**service_role のみ実行可**。

`limit` は Workers のサブリクエスト数上限への対策。上限に当たっても古い順なので、次の起動で回収される。

TypeScript 側の同じ規則は `core/monitor.ts` の `isCheckDue()`。

### purge_old_checks(retention_days = 30)

保持期間を過ぎた観測ログを削除し、削除した行数を返す。SECURITY DEFINER。**service_role のみ実行可**。

### recent_checks(limit = 40)

対象ごとに直近 N 件を返す（`cross join lateral`）。**SECURITY INVOKER** なので RLS がそのまま効き、`authenticated` から呼べる。

一覧に出す「直近のチェック」の帯に使う。稼働率の数字だけでは「いつ落ちたか」が分からない（99.5% は、1回の長い障害でも細かい失敗の散らばりでも同じ値になる）。

---

## ビュー

### monitor_overview

一覧画面が必要とするものを1回の往復で返す。`security_invoker = on`。

`monitors` の全列に加えて:

| 列                      | 内容                           |
| ----------------------- | ------------------------------ |
| `checks_24h` / `up_24h` | 直近24時間の実行回数と成功回数 |
| `checks_7d` / `up_7d`   | 直近7日間の実行回数と成功回数  |
| `avg_response_time_ms`  | 直近24時間の平均応答時間       |
| `last_status_code` 他   | 最新チェックの内容             |

**割り算をビューでしない**のは意図的で、稼働率（`up / total`）の計算と表示は TypeScript 側の `uptimeRatio()` / `formatUptimePercent()` が行う。「チェックが0件のときに 0% ではなく『未計測』を返す」「切り上げない」といった判断はテストが必要な規則であり、DB を立てないと確かめられない場所に置きたくない。

7日ぶんを一度だけ走査し、24時間ぶんは `filter` で切り出している。期間ごとに別のサブクエリを書くと同じ索引を2回走査することになる。

---

## RLS と権限

### 行レベル

| テーブル   | 方針                                                    |
| ---------- | ------------------------------------------------------- |
| `profiles` | 読み取りは認証済み全員、更新は自分の行のみ              |
| `monitors` | `owner_id = auth.uid()` の行だけ CRUD                   |
| `checks`   | 自分の監視対象の行だけ **SELECT**。書き込みポリシー無し |

`monitors` の `with check` を `using` と同じ条件にしているのは、`owner_id` を他人の ID に書き換えて監視対象を押し付ける操作を塞ぐため。

### 列レベル

RLS は「どの行に触れるか」しか決められないので、「どの列を書き換えてよいか」は GRANT で決める。

```sql
revoke all on monitors from anon, authenticated;
grant select, insert, delete on monitors to authenticated;
grant update (name, url, method, expected_status_code,
              interval_seconds, timeout_ms, is_enabled, failure_threshold)
  on monitors to authenticated;
```

判定のキャッシュ列が入っていない。これを外さないと、ダッシュボードから直接 `current_status = 'up'` と書ける。「落ちているのに正常と表示される」状態を、アプリのコードではなく DB で防ぐ。

### 関数の実行権限

Postgres では関数の EXECUTE が**既定で PUBLIC に付く**。放置すると、ログイン済みの誰でも `due_monitors()` を呼べる。この関数は SECURITY DEFINER で RLS を迂回するため、**他人の監視対象の URL がそのまま返る**。

```sql
revoke execute on function due_monitors(integer, integer) from public, anon, authenticated;
grant execute on function due_monitors(integer, integer) to service_role;
```

`record_check()` と `purge_old_checks()` も同様。`recent_checks()` だけが SECURITY INVOKER で `authenticated` に開いてある。

---

## Phase 2 で追加したもの

### incidents

ダウンの**期間**。`checks`（点）から導かれる集約だが、都度計算せずテーブルとして持つ（[`decisions.md`](./decisions.md) の判断 17）。

| 列              | 型               | 備考                                        |
| --------------- | ---------------- | ------------------------------------------- |
| `monitor_id`    | uuid             | 対象削除で連動削除                          |
| `started_at`    | timestamptz      | **最初に失敗した**チェックの時刻            |
| `ended_at`      | timestamptz NULL | 復旧を確認したチェックの時刻。NULL は継続中 |
| `cause`         | check_error_kind | 検知したときの失敗の種類                    |
| `failure_count` | integer          | この障害の間に失敗したチェックの回数        |

**`started_at` が「判定した時刻」ではない理由**: 閾値を N にすると down と判定されるのは N 回目だが、実際に落ちていたのは1回目から。判定時刻を起点にすると、ダウンタイムが「間隔 × (N−1)」ぶん短く記録される。そのために `monitors.first_failure_at` を持つ。

**`ended_at` に成功の時刻を採る理由**: 実際に直ったのは「最後の失敗」と「最初の成功」の間のどこかで、正確には分からない。監視できていない区間を「直っていた」側に数えると稼働率が実態より良くなるので、疑わしい区間はダウン側に入れる。

**不変条件（DB 側で保証）**

```sql
create unique index incidents_one_open_per_monitor on incidents (monitor_id)
  where ended_at is null;
```

「1つの監視対象に、継続中の障害は1本まで」。破れると稼働率が二重計上される。`record_check()` が正しければ破れないが、ロジックが正しいことに依存しないために制約を置く。

### notifications

送信した（これから送る）通知の台帳。

| 列           | 型                  | 備考                                      |
| ------------ | ------------------- | ----------------------------------------- |
| `kind`       | notification_kind   | `monitor_down` / `monitor_recovered`      |
| `dedupe_key` | text UNIQUE         | `monitor_down:<incident_id>` の形         |
| `status`     | notification_status | `pending` / `sent` / `failed` / `skipped` |
| `claimed_at` | timestamptz         | 宣言した時刻（送信の**前**）              |
| `settled_at` | timestamptz         | 結果が確定した時刻                        |

**鍵を incident の ID から作る**のが要点。時刻で追う方式は、実行が飛べば取りこぼし、二度走れば重複する。障害そのものに紐づく鍵なら、いつ何度走っても結果が同じになる。

`status` を持つのは、通知が来なかったときに「送っていない」のか「送ったが届いていない」のかを切り分けるため。画面のタイムラインに表示している。

### monitors への追加

| 列                 | 型               | 備考                                            |
| ------------------ | ---------------- | ----------------------------------------------- |
| `first_failure_at` | timestamptz NULL | 続いている失敗の1回目の時刻。成功で NULL に戻る |

`failure_threshold` の既定値を 1 から **2** に変更した。列自体は Phase 1 から存在する。

### record_check() の拡張

チェック1回で起きる書き込みが4つになった。すべて同じトランザクションで行う。

1. `checks` への追記
2. `monitors` の判定更新（`first_failure_at` を含む）
3. `incidents` の開閉
4. 継続中インシデントの `failure_count` 加算

戻り値に `incident_id` / `incident_started_at` / `failure_threshold` が加わった。通知側が「前回の状態と比べる」処理を持たなくて済むようにするため。

### claim_notification(kind, dedupe_key, monitor_id, incident_id, payload)

送る前に宣言する。`insert ... on conflict do nothing` の結果で判定し、新しく記録できたときだけ `true`。service_role 専用。

判定と記録を別のクエリに分けると、その隙間で複数の Worker が両方とも「まだ送っていない」と判断しうる。

### settle_notification(dedupe_key, status, error_message)

送信の結果を書き戻す。service_role 専用。

### monitor_overview の拡張

| 列                                     | 内容                                  |
| -------------------------------------- | ------------------------------------- |
| `down_seconds_24h` / `down_seconds_7d` | 期間と**重なるぶんだけ**の停止秒数    |
| `incidents_7d`                         | 直近7日間の障害件数                   |
| `open_incident_id`                     | 継続中のインシデント（無ければ NULL） |

期間をまたぐ障害は `least` / `greatest` で切り詰める。「7日前に始まって今も続いている障害」を全期間ぶん数えると、7日間の稼働率が 0% になってしまう。

割り算はここでも行わない。稼働率の計算と表示（`timeBasedUptime()` / `formatUptimePercent()`）は TypeScript 側にあり、テストで押さえている。

### incident_overview

タイムライン画面が使うビュー。`incidents` に監視対象名と、ダウン／復旧それぞれの通知状態を結合したもの。`security_invoker = on`。

### 権限

Phase 1 と同じ方針。`incidents` と `notifications` はどちらも `authenticated` に **SELECT のみ**。開閉と記録は SECURITY DEFINER 関数（service_role 専用）に閉じてある。

---

## Phase 3 で追加したもの

### monitor_members

誰がどの監視対象を見られるか。

| 列           | 型          | 備考                          |
| ------------ | ----------- | ----------------------------- |
| `monitor_id` | uuid        | 主キーの一部                  |
| `user_id`    | uuid        | 主キーの一部                  |
| `role`       | member_role | `owner` / `editor` / `viewer` |
| `invited_by` | uuid NULL   | 誰が追加したか                |

`monitors` に INSERT が入ると、トリガ `add_owner_membership()` が owner の行を作る。アプリ側で2回 INSERT する形にすると、片方だけ成功した監視対象が生まれうる。

既存の監視対象には、この migration の中で owner の行を backfill している。これを忘れると、適用直後に全員が自分の監視対象を見られなくなる。

`profiles.role`（`owner` / `member`）とは別の軸。あちらはアカウント全体の役割で、こちらは「この監視対象に対する」役割。

### status_pages

公開ステータスページ。監視対象ごとに1枚（`monitor_id` に UNIQUE）。

| 列             | 型          | 備考                                         |
| -------------- | ----------- | -------------------------------------------- |
| `slug`         | text UNIQUE | URL に載る22文字。約111ビット                |
| `title`        | text        | 公開ページに出す名前（内部名とは別にできる） |
| `description`  | text        | 200文字まで                                  |
| `is_published` | boolean     | 取り消しは行の削除ではなくフラグで           |

**URL に `monitors.id` を使わない**理由は [`decisions.md`](./decisions.md) の判断 25。要点は「取り消せない」こと。

公開停止（`is_published = false`）と URL の再発行（`rotate_status_page_slug()`）は別の操作にしてある。止めるだけでは、再開したときに同じ URL が生き返る。

### 役割の判定（RLS の再帰を断つ）

```sql
create function can_view_monitor(p_monitor_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from monitor_members mm
    where mm.monitor_id = p_monitor_id and mm.user_id = auth.uid()
  );
$$;
```

`monitors` のポリシーが `monitor_members` を参照し、`monitor_members` のポリシーが `monitors` を参照すると、評価が互いを呼び合って無限再帰する（42P17）。SECURITY DEFINER 関数は RLS を通過するので、この輪を断てる。

同じ形で `can_edit_monitor()`（owner / editor）、`is_monitor_owner()`、`current_member_role()` がある。

**引数は監視対象だけで、ユーザーは常に `auth.uid()` を見る。** 任意のユーザーの役割を返す形にすると、RLS を迂回して他人の権限を調べる道具になる。

### RLS の張り替え

| テーブル         | Phase 1–2               | Phase 3                        |
| ---------------- | ----------------------- | ------------------------------ |
| `monitors` 参照  | `owner_id = auth.uid()` | `can_view_monitor(id)`         |
| `monitors` 更新  | `owner_id = auth.uid()` | `can_edit_monitor(id)`         |
| `monitors` 削除  | `owner_id = auth.uid()` | `is_monitor_owner(id)`         |
| `checks` 参照    | 所有者の監視対象        | `can_view_monitor(monitor_id)` |
| `incidents` 参照 | 所有者の監視対象        | `can_view_monitor(monitor_id)` |

作成（INSERT）だけは `owner_id = auth.uid()` のまま。その時点ではまだ `monitor_members` の行が無い。

`monitor_members` と `status_pages` は `authenticated` に **SELECT のみ**。変更はすべて SECURITY DEFINER 関数を通る。

### public_status(slug, check_limit)

**`anon` に開いている唯一の関数。テーブルは1枚も開いていない。**

返すのは「今動いているか」「どれだけ止まっていたか」「いつ止まっていたか」と応答時間だけ。監視先の URL、`error_message`、`status_code`、内部名、メンバー情報は返さない（判断 26）。

見つからない slug と公開停止中を区別せず、どちらも `null` を返す。区別すると「その slug は存在する」ことを教えてしまう。

### そのほかの RPC（すべて authenticated 限定）

| 関数                          | できる人    | 用途                             |
| ----------------------------- | ----------- | -------------------------------- |
| `publish_status_page()`       | owner       | 発行（再発行時はタイトルも更新） |
| `rotate_status_page_slug()`   | owner       | URL の作り直し                   |
| `set_status_page_published()` | owner       | 公開・停止の切り替え             |
| `monitor_members_of()`        | メンバー    | メンバー一覧（メールを含む）     |
| `add_monitor_member()`        | owner       | メールでメンバーを追加           |
| `set_monitor_member_role()`   | owner       | 役割の変更                       |
| `remove_monitor_member()`     | owner／自分 | メンバーを外す                   |

権限が無い場合は「権限がありません」ではなく `MONITOR_NOT_FOUND` を返す。存在の有無そのものを、権限のない相手に教えない。

`assert_not_last_owner()` が、最後の owner の降格・削除を DB 側で拒否する。owner がいない監視対象は、共有設定も削除も誰にもできない状態になる。

### monitor_overview の拡張

| 列                      | 内容                                     |
| ----------------------- | ---------------------------------------- |
| `viewer_role`           | 呼び出したユーザーのこの対象に対する役割 |
| `member_count`          | メンバー数                               |
| `status_page_slug`      | 公開ページの slug（未発行なら NULL）     |
| `status_page_published` | 公開中か                                 |

`viewer_role` をビューに含められるのは、`current_member_role()` が `auth.uid()` を見る SECURITY DEFINER 関数だから。画面はこれを見て押せないボタンを描かない（防御は RLS 側）。

---

## Phase 4 以降で追加する予定のもの

| 追加するもの                   | 何のために                                        |
| ------------------------------ | ------------------------------------------------- |
| `incidents.postmortem`         | 障害へのメモ。公開ページにも出せるようにする      |
| SSL 証明書の期限               | `monitors` に検査結果を持つ列を足す               |
| レスポンス本文の文字列チェック | `monitors.expected_body` と照合結果               |
| 招待トークン                   | 未登録のユーザーも招待できるようにする（判断 30） |
