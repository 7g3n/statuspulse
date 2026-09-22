/**
 * DB 側の不変条件の検査。
 *
 * ここまでの3フェーズで手作業で確かめてきたものを、そのままテストにした。
 * 対象は「アプリのコードを消しても守られていてほしいこと」だけに絞っている。
 *
 *   - 観測ログと判定キャッシュは、アプリから書けない
 *   - 継続中のインシデントは1対象に1本まで
 *   - 通知は同じ鍵で二度claim できない
 *   - 役割ごとにできることが分かれている
 *   - anon はテーブルに一切触れず、公開用の関数だけが通る
 *
 * 画面の振る舞いは含めない。ここが守られていれば、画面が間違っていても
 * データは壊れないし、他人のものは見えない。
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  canConnect,
  MONITOR_PRIVATE,
  MONITOR_SHARED_EDITOR,
  MONITOR_SHARED_VIEWER,
  OWNER_ID,
  TEAMMATE_ID,
  withSession,
} from './helpers.js';

beforeAll(async () => {
  if (!(await canConnect())) {
    throw new Error(
      'ローカル Supabase につながりません。`pnpm db:start && pnpm db:reset` を実行してください。',
    );
  }
}, 20_000);

/* -------------------------------------------------------------------------- */
/* 観測ログと判定キャッシュ                                                    */
/* -------------------------------------------------------------------------- */

describe('観測ログはアプリから書けない', () => {
  /**
   * 稼働率は「このログを誰も書き換えていない」ことの上に成り立つ数字でしかない。
   * 書き込める経路が1つでもあれば、この数字は誰にも信用できなくなる。
   */
  it('checks へ INSERT できない', async () => {
    await withSession({ role: 'authenticated', userId: OWNER_ID }, async (session) => {
      const error = await session.expectError(
        `insert into checks (monitor_id, result, error_kind) values ($1, 'down', 'unknown')`,
        [MONITOR_PRIVATE],
      );
      expect(error).toMatch(/permission denied/);
    });
  });

  it('checks を UPDATE / DELETE できない', async () => {
    await withSession({ role: 'authenticated', userId: OWNER_ID }, async (session) => {
      expect(await session.expectError(`update checks set result = 'up'`)).toMatch(
        /permission denied/,
      );
      expect(await session.expectError(`delete from checks`)).toMatch(/permission denied/);
    });
  });

  /**
   * RLS は「どの行に触れるか」しか決められない。「どの列を書き換えてよいか」は
   * 列単位の GRANT が決める。ここが外れていると、ダッシュボードから
   * current_status = 'up' と書けてしまう。
   */
  it('判定のキャッシュ列を UPDATE できない', async () => {
    await withSession({ role: 'authenticated', userId: OWNER_ID }, async (session) => {
      for (const column of [
        `current_status = 'up'`,
        'consecutive_failures = 0',
        'last_checked_at = now()',
        'first_failure_at = null',
      ]) {
        const error = await session.expectError(`update monitors set ${column} where id = $1`, [
          MONITOR_PRIVATE,
        ]);
        expect(error, column).toMatch(/permission denied/);
      }
    });
  });

  it('設定の列は UPDATE できる（塞ぎすぎていないことの確認）', async () => {
    await withSession({ role: 'authenticated', userId: OWNER_ID }, async (session) => {
      const { rows } = await session.query(
        `update monitors set timeout_ms = 9500 where id = $1 returning timeout_ms`,
        [MONITOR_PRIVATE],
      );
      expect(rows[0]?.['timeout_ms']).toBe(9500);
    });
  });

  it('incidents / notifications も読み取り専用', async () => {
    await withSession({ role: 'authenticated', userId: OWNER_ID }, async (session) => {
      expect(
        await session.expectError(
          `insert into incidents (monitor_id, started_at, cause) values ($1, now(), 'unknown')`,
          [MONITOR_PRIVATE],
        ),
      ).toMatch(/permission denied/);
      expect(await session.expectError(`update notifications set status = 'sent'`)).toMatch(
        /permission denied/,
      );
    });
  });
});

/* -------------------------------------------------------------------------- */
/* record_check の状態遷移                                                     */
/* -------------------------------------------------------------------------- */

describe('record_check', () => {
  it('閾値に届くまで down にならず、届いた回に went_down を返す', async () => {
    await withSession({ role: 'service_role' }, async (session) => {
      await session.query(`update monitors set failure_threshold = 3 where id = $1`, [
        MONITOR_SHARED_EDITOR,
      ]);

      const events: unknown[] = [];
      for (let i = 0; i < 3; i += 1) {
        const { rows } = await session.query(
          `select record_check($1, 'down', 500, 10, 'status', 'e') as r`,
          [MONITOR_SHARED_EDITOR],
        );
        events.push((rows[0]?.['r'] as Record<string, unknown>)['event']);
      }

      expect(events).toEqual([null, null, 'went_down']);
    });
  });

  /**
   * 閾値 N のぶん遅れた時刻を起点にすると、ダウンタイムが「間隔 × (N−1)」短く記録される。
   * 誤検知を減らすための設定が、稼働率を良く見せる方向に働いてはならない。
   */
  it('インシデントの開始時刻は「最初に失敗した時刻」になる', async () => {
    await withSession({ role: 'service_role' }, async (session) => {
      await session.query(
        `update monitors set failure_threshold = 3, current_status = 'up',
           consecutive_failures = 0, first_failure_at = null where id = $1`,
        [MONITOR_SHARED_EDITOR],
      );

      const first = await session.query(
        `select record_check($1, 'down', 500, 10, 'status', 'e') as r, now() as at`,
        [MONITOR_SHARED_EDITOR],
      );
      const firstFailureAt = first.rows[0]?.['at'] as Date;

      await session.query(`select record_check($1, 'down', 500, 10, 'status', 'e')`, [
        MONITOR_SHARED_EDITOR,
      ]);
      const third = await session.query(
        `select record_check($1, 'down', 500, 10, 'status', 'e') as r`,
        [MONITOR_SHARED_EDITOR],
      );

      const incidentId = (third.rows[0]?.['r'] as Record<string, unknown>)['incident_id'];
      const { rows } = await session.query(`select started_at from incidents where id = $1`, [
        incidentId,
      ]);

      // 3回目ではなく1回目の時刻（同一トランザクションなので now() は同じ値になる）
      expect((rows[0]?.['started_at'] as Date).getTime()).toBe(firstFailureAt.getTime());
    });
  });

  it('復旧は1回の成功で足りる', async () => {
    await withSession({ role: 'service_role' }, async (session) => {
      await session.query(
        `update monitors set failure_threshold = 1, current_status = 'up',
           consecutive_failures = 0, first_failure_at = null where id = $1`,
        [MONITOR_SHARED_EDITOR],
      );
      await session.query(`select record_check($1, 'down', 500, 10, 'status', 'e')`, [
        MONITOR_SHARED_EDITOR,
      ]);
      const { rows } = await session.query(
        `select record_check($1, 'up', 200, 10, null, null) as r`,
        [MONITOR_SHARED_EDITOR],
      );
      expect((rows[0]?.['r'] as Record<string, unknown>)['event']).toBe('recovered');
    });
  });

  /**
   * record_check() のロジックが壊れても、同じ障害が2本記録される状態にはしない。
   * 稼働率の二重計上を DB 側で防ぐ。
   */
  it('継続中のインシデントは1対象に1本まで', async () => {
    await withSession({ role: 'postgres' }, async (session) => {
      const { rows } = await session.query(
        `select monitor_id from incidents where ended_at is null limit 1`,
      );
      const monitorId = rows[0]?.['monitor_id'];
      expect(monitorId, 'seed に継続中のインシデントが必要').toBeDefined();

      const error = await session.expectError(
        `insert into incidents (monitor_id, started_at, cause) values ($1, now(), 'unknown')`,
        [monitorId],
      );
      expect(error).toMatch(/incidents_one_open_per_monitor|duplicate key/);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 通知の冪等性                                                                */
/* -------------------------------------------------------------------------- */

describe('claim_notification', () => {
  it('同じ鍵では1回しか claim できない', async () => {
    await withSession({ role: 'service_role' }, async (session) => {
      const key = 'test:' + Math.random();
      const first = await session.query(
        `select claim_notification('monitor_down', $1, null, null, '{}'::jsonb) as ok`,
        [key],
      );
      const second = await session.query(
        `select claim_notification('monitor_down', $1, null, null, '{}'::jsonb) as ok`,
        [key],
      );
      expect(first.rows[0]?.['ok']).toBe(true);
      expect(second.rows[0]?.['ok']).toBe(false);
    });
  });

  it('authenticated からは呼べない', async () => {
    await withSession({ role: 'authenticated', userId: OWNER_ID }, async (session) => {
      const error = await session.expectError(
        `select claim_notification('monitor_down', 'x', null, null, '{}'::jsonb)`,
      );
      expect(error).toMatch(/permission denied/);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 役割                                                                        */
/* -------------------------------------------------------------------------- */

describe('役割ごとにできること', () => {
  it('共有されていない監視対象は見えない', async () => {
    await withSession({ role: 'authenticated', userId: TEAMMATE_ID }, async (session) => {
      const { rows } = await session.query(`select id from monitors order by id`);
      const visible = rows.map((row) => row['id']);
      expect(visible).toContain(MONITOR_SHARED_VIEWER);
      expect(visible).toContain(MONITOR_SHARED_EDITOR);
      expect(visible).not.toContain(MONITOR_PRIVATE);
    });
  });

  it('viewer は設定を変更できない（RLS で対象行から外れる）', async () => {
    await withSession({ role: 'authenticated', userId: TEAMMATE_ID }, async (session) => {
      const { rows } = await session.query(
        `update monitors set timeout_ms = 1234 where id = $1 returning id`,
        [MONITOR_SHARED_VIEWER],
      );
      expect(rows).toHaveLength(0);
    });
  });

  it('editor は変更できるが、削除はできない', async () => {
    await withSession({ role: 'authenticated', userId: TEAMMATE_ID }, async (session) => {
      const updated = await session.query(
        `update monitors set timeout_ms = 4321 where id = $1 returning id`,
        [MONITOR_SHARED_EDITOR],
      );
      expect(updated.rows).toHaveLength(1);

      const deleted = await session.query(`delete from monitors where id = $1 returning id`, [
        MONITOR_SHARED_EDITOR,
      ]);
      expect(deleted.rows).toHaveLength(0);
    });
  });

  it('owner 以外は共有設定と公開ページを触れない', async () => {
    await withSession({ role: 'authenticated', userId: TEAMMATE_ID }, async (session) => {
      // 「権限がありません」ではなく「見つかりません」を返す（存在を教えない）
      expect(
        await session.expectError(`select publish_status_page($1)`, [MONITOR_SHARED_EDITOR]),
      ).toMatch(/MONITOR_NOT_FOUND/);
      expect(
        await session.expectError(`select add_monitor_member($1, 'x@example.com', 'owner')`, [
          MONITOR_SHARED_EDITOR,
        ]),
      ).toMatch(/MONITOR_NOT_FOUND/);
    });
  });

  /**
   * owner が1人もいない監視対象は、共有設定も削除も誰にもできない状態になる。
   * 直す手段が DB を直接触ることしか残らないので、DB 側で拒否する。
   */
  it('最後の owner は降格も削除もできない', async () => {
    await withSession({ role: 'authenticated', userId: OWNER_ID }, async (session) => {
      expect(
        await session.expectError(`select set_monitor_member_role($1, $2, 'viewer')`, [
          MONITOR_PRIVATE,
          OWNER_ID,
        ]),
      ).toMatch(/LAST_OWNER/);

      expect(
        await session.expectError(`select remove_monitor_member($1, $2)`, [
          MONITOR_PRIVATE,
          OWNER_ID,
        ]),
      ).toMatch(/LAST_OWNER/);
    });
  });

  it('viewer はポストモーテムを書けない', async () => {
    await withSession({ role: 'authenticated', userId: TEAMMATE_ID }, async (session) => {
      const { rows } = await session.query(
        `select id from incidents where monitor_id = $1 limit 1`,
        [MONITOR_SHARED_VIEWER],
      );
      if (rows.length === 0) return; // seed に無ければ何も確かめられない

      const error = await session.expectError(`select set_incident_postmortem($1, 'x', true)`, [
        rows[0]?.['id'],
      ]);
      expect(error).toMatch(/INCIDENT_NOT_FOUND/);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 匿名アクセス                                                                */
/* -------------------------------------------------------------------------- */

describe('anon から触れるもの', () => {
  /**
   * 公開ページのために anon に開いているのは public_status() ただ1つ。
   * テーブルを開くと「公開中の監視対象を全件列挙する」ことができてしまい、
   * 他人の公開ページとその監視先 URL まで引ける。
   */
  it('テーブルには一切触れない', async () => {
    await withSession({ role: 'anon' }, async (session) => {
      for (const table of [
        'monitors',
        'checks',
        'incidents',
        'notifications',
        'status_pages',
        'monitor_members',
        'profiles',
      ]) {
        const error = await session.expectError(`select * from ${table} limit 1`);
        expect(error, table).toMatch(/permission denied/);
      }
    });
  });

  it('役割の判定に使う関数も呼べない', async () => {
    await withSession({ role: 'anon' }, async (session) => {
      for (const call of [
        `select can_view_monitor('${MONITOR_PRIVATE}')`,
        `select monitor_members_of('${MONITOR_PRIVATE}')`,
        `select due_monitors()`,
        `select generate_status_page_slug()`,
      ]) {
        expect(await session.expectError(call), call).toMatch(/permission denied/);
      }
    });
  });

  it('slug を知っていれば公開ページの内容だけ取れる', async () => {
    await withSession({ role: 'anon' }, async (session) => {
      const { rows } = await session.query(`select public_status('demo-stockdesk-status') as s`);
      const status = rows[0]?.['s'] as Record<string, unknown> | null;

      expect(status).not.toBeNull();
      expect(status?.['title']).toBe('StockDesk');

      // 出してはいけないものが入っていないこと
      const serialized = JSON.stringify(status);
      expect(serialized).not.toContain('stockdesk.example.com'); // 監視先の URL
      expect(serialized).not.toContain('status_code');
      expect(serialized).not.toContain('error_message');
      expect(serialized).not.toContain('owner_id');
    });
  });

  it('存在しない slug と公開停止中を区別しない', async () => {
    await withSession({ role: 'anon' }, async (session) => {
      const missing = await session.query(`select public_status('zzzzzzzzzzzzzzzzzzzzzz') as s`);
      expect(missing.rows[0]?.['s']).toBeNull();
    });
  });

  it('公開を止めると取得できなくなる', async () => {
    // 止める操作は owner で行い、確認は anon で行う。
    // 同じトランザクションでロールを切り替えたいので postgres で両方を演じる。
    await withSession({ role: 'postgres' }, async (session) => {
      await session.query(`update status_pages set is_published = false`);
      await session.query(`set local role anon`);
      const { rows } = await session.query(`select public_status('demo-stockdesk-status') as s`);
      expect(rows[0]?.['s']).toBeNull();
    });
  });
});
