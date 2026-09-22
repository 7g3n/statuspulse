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

## Phase 2 以降で追加する予定のもの

| 追加するもの                   | 何のために                                           |
| ------------------------------ | ---------------------------------------------------- |
| `incidents` テーブル           | ダウンタイムの期間を持ち、時間ベースの稼働率に移行   |
| `notifications` テーブル       | 送信前に記録して Slack 通知の重複を防ぐ              |
| `failure_threshold` の UI 公開 | 連続N回失敗でダウンと判定する（列は Phase 1 にある） |
| `status_pages` テーブル        | 公開ステータスページの発行（認証不要の SELECT）      |
| `monitor_members` テーブル     | チームでの共有。`monitors` の RLS を張り替える       |
