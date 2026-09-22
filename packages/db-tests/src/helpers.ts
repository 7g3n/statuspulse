/**
 * ローカル Supabase に直接つないで、DB 側の不変条件を確かめるための足回り。
 *
 * **なぜ pnpm test に含めないのか**
 *   このスイートは Docker とローカル Supabase を必要とする。
 *   `pnpm test`（判定ロジックの単体テスト）は DB を立てずに数百ミリ秒で終わることに
 *   価値があるので、そこに混ぜない。`pnpm test:db` で別に走らせる。
 *
 * **なぜ supabase-js ではなく pg で接続するのか**
 *   確かめたいのは「アプリを経由しない書き込みも塞がれているか」で、
 *   supabase-js は PostgREST という経路の話でしかない。
 *   ロールを切り替えて素の SQL を投げられる必要がある。
 */
import { Client } from 'pg';

export const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres';

/** seed.sql が作る2人。役割ごとの見え方を確かめるのに使う。 */
export const OWNER_ID = '00000000-0000-0000-0000-0000000000a1';
export const TEAMMATE_ID = '00000000-0000-0000-0000-0000000000a2';

/** seed.sql の監視対象。teammate には b1 が viewer、b2 が editor で共有されている。 */
export const MONITOR_SHARED_VIEWER = '00000000-0000-0000-0000-0000000000b1';
export const MONITOR_SHARED_EDITOR = '00000000-0000-0000-0000-0000000000b2';
export const MONITOR_PRIVATE = '00000000-0000-0000-0000-0000000000b4';

export async function canConnect(): Promise<boolean> {
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

export type Session = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  /** 実行して、失敗したらそのメッセージを返す。成功したら null。 */
  expectError: (sql: string, values?: unknown[]) => Promise<string | null>;
};

type Role = 'anon' | 'authenticated' | 'service_role' | 'postgres';

/**
 * ロールとユーザーを指定して SQL を流し、**必ずロールバックする**。
 *
 * 各テストが直前のテストの書き込みを見ないようにするための仕組み。
 * seed のデータをそのまま前提にできるので、テストごとの準備が要らない。
 */
export async function withSession(
  options: { role: Role; userId?: string },
  body: (session: Session) => Promise<void>,
): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    await client.query('begin');

    if (options.role !== 'postgres') {
      const claims =
        options.userId === undefined
          ? JSON.stringify({ role: options.role })
          : JSON.stringify({ role: options.role, sub: options.userId });

      // is_local = true にして、ロールバックと一緒に元へ戻す。
      await client.query('select set_config($1, $2, true)', ['request.jwt.claims', claims]);
      await client.query(`set local role ${options.role}`);
    }

    await body({
      query: async (sql, values) => {
        const result = await client.query(sql, values as never[]);
        return { rows: result.rows as Record<string, unknown>[] };
      },
      expectError: async (sql, values) => {
        // 失敗したステートメントはトランザクションを壊すので、
        // savepoint で包んで後続のクエリを続けられるようにする。
        await client.query('savepoint attempt');
        try {
          await client.query(sql, values as never[]);
          await client.query('release savepoint attempt');
          return null;
        } catch (error) {
          await client.query('rollback to savepoint attempt');
          return error instanceof Error ? error.message : String(error);
        }
      },
    });
  } finally {
    await client.query('rollback').catch(() => undefined);
    await client.end();
  }
}
