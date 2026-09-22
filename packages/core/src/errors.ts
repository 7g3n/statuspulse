/**
 * DB 関数が返すエラーの、TypeScript 側の対応表。
 *
 * Postgres の RPC はメッセージ先頭に機械可読なコードを付けて返す。
 *   例: 'MONITOR_NOT_FOUND: 監視対象が見つかりません'
 * 画面側で分岐できるよう、ここでコードを型として固定しておく。
 */

export const APP_ERROR_CODES = [
  'UNAUTHENTICATED',
  'MONITOR_NOT_FOUND',
  'INVALID_MONITOR_URL',
  'INVALID_INTERVAL',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export class AppError extends Error {
  readonly code: AppErrorCode;

  constructor(code: AppErrorCode, message: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

/** 監視対象の URL が受け入れられないときに投げる。 */
export class InvalidMonitorUrlError extends AppError {
  constructor(message: string) {
    super('INVALID_MONITOR_URL', message);
    this.name = 'InvalidMonitorUrlError';
  }
}

const CODE_PATTERN = new RegExp('^(' + APP_ERROR_CODES.join('|') + '):\\s*');

/**
 * supabase-js が返す PostgrestError のメッセージから、先頭のコードを取り出す。
 * コードが付いていなければ null（＝こちらが想定していないエラー）。
 */
export function parseAppError(message: string): AppError | null {
  const matched = CODE_PATTERN.exec(message);
  if (!matched) return null;
  return new AppError(matched[1] as AppErrorCode, message.slice(matched[0].length));
}
