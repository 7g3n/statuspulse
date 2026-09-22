import { zodResolver } from '@hookform/resolvers/zod';
import {
  CHECK_INTERVAL_LABELS,
  CHECK_INTERVALS,
  detectionDelaySeconds,
  FAILURE_THRESHOLDS,
  formatDowntime,
  HTTP_METHODS,
  isCheckInterval,
  MONITOR_FORM_DEFAULTS,
  monitorFormSchema,
  type MonitorFormValues,
  type MonitorOverviewRow,
} from '@statuspulse/core';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button, Field, Input, Modal, Select } from '@/components/ui';

import { useCreateMonitor, useUpdateMonitor } from './api';

/**
 * 編集時に、既存の行をフォームの値へ写す。
 *
 * interval_seconds は DB の CHECK 制約で選択肢のいずれかに限られているが、
 * 型の上では単なる number なので、ここで選択肢に収まることを確かめる。
 * 収まらない値（制約を足す前のデータなど）は既定値に落として、
 * 選択肢に無い値が選ばれた状態の <select> を作らない。
 */
function toFormValues(monitor: MonitorOverviewRow): MonitorFormValues {
  return {
    name: monitor.name,
    url: monitor.url,
    method: monitor.method,
    intervalSeconds: isCheckInterval(monitor.interval_seconds)
      ? monitor.interval_seconds
      : MONITOR_FORM_DEFAULTS.intervalSeconds,
    failureThreshold: monitor.failure_threshold,
    expectedBodyText: monitor.expected_body_text,
    checkCertificate: monitor.check_certificate,
    timeoutMs: monitor.timeout_ms,
    expectedStatusCode: monitor.expected_status_code,
    isEnabled: monitor.is_enabled,
  };
}

export function MonitorFormDialog({
  open,
  monitor,
  onClose,
}: {
  open: boolean;
  /** 未指定なら新規登録。 */
  monitor?: MonitorOverviewRow | undefined;
  onClose: () => void;
}) {
  const createMonitor = useCreateMonitor();
  const updateMonitor = useUpdateMonitor();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<MonitorFormValues>({
    resolver: zodResolver(monitorFormSchema),
    defaultValues: monitor ? toFormValues(monitor) : MONITOR_FORM_DEFAULTS,
  });

  // 開くたびに対象の値へ戻す。前回開いたときの入力が残っていると、
  // 別の対象を編集しているつもりで違う値を送ることになる。
  useEffect(() => {
    if (!open) return;
    reset(monitor ? toFormValues(monitor) : MONITOR_FORM_DEFAULTS);
    setSubmitError(null);
  }, [open, monitor, reset]);

  /**
   * 閾値を上げると誤検知は減るが、そのぶん検知が遅れる。
   * 選んでいるその場で遅れの大きさを出す。トレードオフを数字にしないと利用者は選べない
   * （1時間間隔で3回は、最大2時間気付けないという意味になる）。
   */
  const intervalSeconds = watch('intervalSeconds');
  const failureThreshold = watch('failureThreshold');
  const delaySeconds = detectionDelaySeconds(intervalSeconds, failureThreshold);
  const thresholdHint =
    delaySeconds === 0
      ? '1回でも失敗したら異常とみなす。瞬間的な切断でも通知が飛ぶ'
      : `検知が最大 ${formatDowntime(delaySeconds)} 遅れる代わりに、瞬間的な切断では通知しない`;

  async function onSubmit(values: MonitorFormValues) {
    setSubmitError(null);

    try {
      if (monitor) {
        await updateMonitor.mutateAsync({ id: monitor.id, values });
      } else {
        await createMonitor.mutateAsync(values);
      }
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '保存できませんでした');
    }
  }

  return (
    <Modal open={open} title={monitor ? '監視対象を編集' : '監視対象を追加'} onClose={onClose}>
      <form onSubmit={(event) => void handleSubmit(onSubmit)(event)} className="space-y-4">
        <Field label="名前" htmlFor="name" error={errors.name?.message}>
          <Input id="name" placeholder="StockDesk（本番）" {...register('name')} />
        </Field>

        <Field
          label="URL"
          htmlFor="url"
          hint="http(s) の公開 URL。localhost や私有 IP は監視できません。"
          error={errors.url?.message}
        >
          <Input
            id="url"
            placeholder="https://example.com/"
            autoComplete="off"
            spellCheck={false}
            {...register('url')}
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field
            label="メソッド"
            htmlFor="method"
            hint="本文が不要なら HEAD が軽い"
            error={errors.method?.message}
          >
            <Select id="method" {...register('method')}>
              {HTTP_METHODS.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="チェック間隔"
            htmlFor="intervalSeconds"
            hint="短いほど検知は速く、相手の負荷は増える"
            error={errors.intervalSeconds?.message}
          >
            <Select id="intervalSeconds" {...register('intervalSeconds', { valueAsNumber: true })}>
              {CHECK_INTERVALS.map((interval) => (
                <option key={interval} value={interval}>
                  {CHECK_INTERVAL_LABELS[interval]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field
            label="タイムアウト (ms)"
            htmlFor="timeoutMs"
            hint="これを超えたら異常とみなす"
            error={errors.timeoutMs?.message}
          >
            <Input
              id="timeoutMs"
              type="number"
              min={1000}
              max={30000}
              step={500}
              {...register('timeoutMs', { valueAsNumber: true })}
            />
          </Field>

          <Field
            label="期待するステータス"
            htmlFor="expectedStatusCode"
            hint="未入力なら 2xx / 3xx を正常とみなす"
            error={errors.expectedStatusCode?.message}
          >
            <Input
              id="expectedStatusCode"
              type="number"
              min={100}
              max={599}
              placeholder="200"
              {...register('expectedStatusCode', {
                // 空欄は「指定なし」。0 や NaN ではなく null に寄せる。
                setValueAs: (value: unknown) =>
                  value === '' || value === null || value === undefined ? null : Number(value),
              })}
            />
          </Field>
        </div>

        <Field
          label="異常と判定する連続失敗回数"
          htmlFor="failureThreshold"
          hint={thresholdHint}
          error={errors.failureThreshold?.message}
        >
          <Select id="failureThreshold" {...register('failureThreshold', { valueAsNumber: true })}>
            {FAILURE_THRESHOLDS.map((threshold) => (
              <option key={threshold} value={threshold}>
                {threshold}回
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="本文に含まれているべき文字列"
          htmlFor="expectedBodyText"
          hint="空欄なら本文を見ません。ステータスが 200 でも中身が壊れている状態を捉えるための設定です"
          error={errors.expectedBodyText?.message}
        >
          <Input
            id="expectedBodyText"
            placeholder="ログイン"
            maxLength={200}
            {...register('expectedBodyText', {
              // 空欄は「設定なし」。空文字のまま送ると DB では「空文字を含むか」になる。
              setValueAs: (value: unknown) =>
                typeof value === 'string' && value.trim() !== '' ? value : null,
            })}
          />
        </Field>

        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            className="mt-0.5 size-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
            {...register('checkCertificate')}
          />
          <span className="text-sm text-slate-700">
            TLS 証明書の期限を監視する
            <span className="mt-0.5 block text-xs text-slate-500">
              1日1回、残り30日と7日で通知します。http:// の URL では無視されます。
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            className="mt-0.5 size-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
            {...register('isEnabled')}
          />
          <span className="text-sm text-slate-700">
            監視を有効にする
            <span className="mt-0.5 block text-xs text-slate-500">
              外すとチェックを止めます。履歴と過去の稼働率は残ります。
            </span>
          </span>
        </label>

        {submitError && <p className="text-sm text-down-700">{submitError}</p>}

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button type="button" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" variant="primary" loading={isSubmitting}>
            {monitor ? '保存' : '追加'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
