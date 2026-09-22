/**
 * 入力の検証スキーマ（zod）。
 *
 * 画面のフォームがここを通る。DB 側にも CHECK 制約があるので、
 * これは防御の一段目であって最後の砦ではない。
 * ここでの役割は「送る前に、人に分かる言葉で間違いを伝えること」。
 *
 * 検証（このスキーマ）と正規化（normalizeMonitorValues）を分けてある。
 * スキーマの中で変換すると入力の型と出力の型がずれ、react-hook-form が扱う値と
 * 送信される値が別物になる。フォームの値はフォームの値のまま保ち、
 * 正規化は書き込みの直前に1か所で行う。
 */

import { z } from 'zod';

import {
  CHECK_INTERVALS,
  DEFAULT_TIMEOUT_MS,
  HTTP_METHODS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  isCheckInterval,
} from './monitor.js';
import { isValidMonitorUrl, normalizeMonitorUrl } from './url.js';

export const monitorFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, '名前を入力してください')
    .max(60, '名前は60文字以内で入力してください'),

  url: z.string().trim().min(1, 'URL を入力してください').refine(isValidMonitorUrl, {
    message: 'http(s) の公開 URL を指定してください（localhost や私有 IP は監視できません）',
  }),

  method: z.enum(HTTP_METHODS),

  intervalSeconds: z
    .number({ invalid_type_error: 'チェック間隔を選択してください' })
    .int()
    .refine(isCheckInterval, { message: 'チェック間隔が不正です' }),

  timeoutMs: z
    .number({ invalid_type_error: 'タイムアウトを数値で入力してください' })
    .int()
    .min(MIN_TIMEOUT_MS, 'タイムアウトは1000ms 以上で指定してください')
    .max(MAX_TIMEOUT_MS, 'タイムアウトは30000ms 以内で指定してください'),

  // 未指定（null）なら 2xx / 3xx を正常とみなす（monitor.ts の isAcceptableStatus 参照）。
  expectedStatusCode: z
    .number({ invalid_type_error: 'ステータスコードを数値で入力してください' })
    .int()
    .min(100, 'ステータスコードは100〜599で指定してください')
    .max(599, 'ステータスコードは100〜599で指定してください')
    .nullable(),

  isEnabled: z.boolean(),
});

export type MonitorFormValues = z.infer<typeof monitorFormSchema>;

/**
 * 書き込み直前の正規化。
 *
 * URL の表記ゆれ（末尾スラッシュ、スキームの大文字、フラグメント）を1つの形に寄せる。
 * これを通さないと、同じ対象が別の行として二重に登録され、
 * 相手への負荷が倍になるうえ、稼働率も2つに割れてしまう。
 *
 * 検証済みの値を前提にするので、ここで例外が出ることは想定していない
 * （出るとすれば、スキーマを通していない経路がある）。
 */
export function normalizeMonitorValues(values: MonitorFormValues): MonitorFormValues {
  return { ...values, name: values.name.trim(), url: normalizeMonitorUrl(values.url) };
}

/** 新規登録フォームの初期値。 */
export const MONITOR_FORM_DEFAULTS: MonitorFormValues = {
  name: '',
  url: '',
  method: 'GET',
  // 1分間隔は相手への負荷が大きいので既定にしない。5分から始めて、必要なら縮める。
  intervalSeconds: CHECK_INTERVALS[1],
  timeoutMs: DEFAULT_TIMEOUT_MS,
  expectedStatusCode: null,
  isEnabled: true,
};
