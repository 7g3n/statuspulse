/**
 * @statuspulse/core
 *
 * 判定ロジック・型・検証スキーマの単一の置き場。
 * web（画面）と cron（Cloudflare Workers）の両方がここを参照する。
 *
 * このパッケージは React にも Supabase にも依存しない。
 * DB も Worker も起動せずにテストできることが、
 * 「ダウン判定」という最も壊れてはいけない部分の検証コストを下げる一番の近道だという判断による。
 */

export * from './monitor.js';
export * from './incident.js';
export * from './slack.js';
export * from './uptime.js';
export * from './url.js';
export * from './errors.js';
export * from './schemas.js';
export * from './database.types.js';
