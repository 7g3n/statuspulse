import {
  ASSIGNABLE_MEMBER_ROLES,
  MEMBER_ROLE_DESCRIPTIONS,
  MEMBER_ROLE_LABELS,
  statusPageUrl,
  type MemberRole,
  type MonitorOverviewRow,
} from '@statuspulse/core';
import { useState, type FormEvent } from 'react';

import { Button, Card, ErrorBlock, Field, Input, LoadingBlock, Select } from '@/components/ui';

import {
  useAddMember,
  useMembers,
  usePublishStatusPage,
  useRemoveMember,
  useRotateStatusPageSlug,
  useSetMemberRole,
  useSetStatusPagePublished,
} from './api';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/* -------------------------------------------------------------------------- */
/* メンバー                                                                    */
/* -------------------------------------------------------------------------- */

function MembersSection({ monitor }: { monitor: MonitorOverviewRow }) {
  const members = useMembers(monitor.id);
  const addMember = useAddMember(monitor.id);
  const setRole = useSetMemberRole(monitor.id);
  const removeMember = useRemoveMember(monitor.id);

  const [email, setEmail] = useState('');
  const [role, setRole_] = useState<MemberRole>('viewer');
  const [error, setError] = useState<string | null>(null);

  const isOwner = monitor.viewer_role === 'owner';

  async function onAdd(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await addMember.mutateAsync({ email, role });
      setEmail('');
    } catch (caught) {
      setError(errorMessage(caught, 'メンバーを追加できませんでした'));
    }
  }

  async function onChangeRole(userId: string, next: MemberRole) {
    setError(null);
    try {
      await setRole.mutateAsync({ userId, role: next });
    } catch (caught) {
      setError(errorMessage(caught, '役割を変更できませんでした'));
    }
  }

  async function onRemove(userId: string) {
    setError(null);
    try {
      await removeMember.mutateAsync(userId);
    } catch (caught) {
      setError(errorMessage(caught, 'メンバーを削除できませんでした'));
    }
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-900">メンバー</h3>
      <p className="mt-1 text-xs text-slate-500">
        追加した人はこの監視対象の状態と履歴を見られます。監視先の URL も見えます。
      </p>

      {members.isPending ? (
        <LoadingBlock />
      ) : members.error ? (
        <ErrorBlock error={members.error} onRetry={() => void members.refetch()} />
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {(members.data ?? []).map((member) => (
            <li key={member.user_id} className="flex items-center gap-2 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-slate-900">
                  {member.display_name}
                  {member.is_self && (
                    <span className="ml-1.5 text-xs text-slate-400">（自分）</span>
                  )}
                </p>
                <p className="truncate text-xs text-slate-500">{member.email}</p>
              </div>

              {isOwner ? (
                // Select は基底クラスで w-full なので、幅は外側の箱で決める
                // （同じ width ユーティリティ同士は class の書き順では勝てない）。
                <div className="w-28 shrink-0">
                  <Select
                    aria-label={`${member.display_name} の役割`}
                    className="py-1.5 text-xs"
                    value={member.role}
                    onChange={(event) =>
                      void onChangeRole(member.user_id, event.target.value as MemberRole)
                    }
                  >
                    {ASSIGNABLE_MEMBER_ROLES.map((item) => (
                      <option key={item} value={item}>
                        {MEMBER_ROLE_LABELS[item]}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : (
                <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600">
                  {MEMBER_ROLE_LABELS[member.role]}
                </span>
              )}

              {/* 自分で抜けるのは所有者でなくても許す（共有された側が縁を切れないのは不便）。 */}
              {(isOwner || member.is_self) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void onRemove(member.user_id)}
                  aria-label={`${member.display_name} を外す`}
                >
                  外す
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {isOwner && (
        <form
          onSubmit={(event) => void onAdd(event)}
          className="mt-3 flex flex-wrap items-end gap-2"
        >
          <div className="min-w-48 flex-1">
            <Field
              label="メールアドレスで追加"
              htmlFor="member-email"
              hint="StatusPulse に登録済みのユーザーのみ追加できます"
            >
              <Input
                id="member-email"
                type="email"
                required
                placeholder="teammate@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
          </div>

          <div className="w-28 shrink-0">
            <Select
              aria-label="追加するときの役割"
              value={role}
              onChange={(event) => setRole_(event.target.value as MemberRole)}
            >
              {ASSIGNABLE_MEMBER_ROLES.map((item) => (
                <option key={item} value={item}>
                  {MEMBER_ROLE_LABELS[item]}
                </option>
              ))}
            </Select>
          </div>

          <Button type="submit" variant="primary" loading={addMember.isPending}>
            追加
          </Button>
        </form>
      )}

      {error && <p className="mt-2 text-sm text-down-700">{error}</p>}

      {isOwner && (
        <dl className="mt-4 space-y-1 border-t border-slate-100 pt-3 text-xs text-slate-500">
          {ASSIGNABLE_MEMBER_ROLES.map((item) => (
            <div key={item} className="flex gap-2">
              <dt className="w-14 shrink-0 font-medium text-slate-600">
                {MEMBER_ROLE_LABELS[item]}
              </dt>
              <dd>{MEMBER_ROLE_DESCRIPTIONS[item]}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 公開ステータスページ                                                        */
/* -------------------------------------------------------------------------- */

function StatusPageSection({ monitor }: { monitor: MonitorOverviewRow }) {
  const publishPage = usePublishStatusPage(monitor.id);
  const rotateSlug = useRotateStatusPageSlug(monitor.id);
  const setPublished = useSetStatusPagePublished(monitor.id);

  const [title, setTitle] = useState(monitor.name);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmingRotate, setConfirmingRotate] = useState(false);

  const url = monitor.status_page_slug
    ? statusPageUrl(window.location.origin, monitor.status_page_slug)
    : null;

  async function run(action: () => Promise<unknown>, fallback: string) {
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught, fallback));
    }
  }

  async function onCopy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // クリップボードが使えない環境（権限・非 HTTPS）でも URL は下に出ている。
      setError('コピーできませんでした。URL を手動で選択してください。');
    }
  }

  return (
    <div className="mt-6 border-t border-slate-100 pt-5">
      <h3 className="text-sm font-semibold text-slate-900">公開ステータスページ</h3>
      <p className="mt-1 text-xs text-slate-500">
        URL を知っている人なら誰でも、ログインせずに稼働状況を見られます。
        <span className="text-slate-600">監視先の URL とエラーの内容は公開されません。</span>
      </p>

      {!monitor.status_page_slug ? (
        <div className="mt-3 space-y-3">
          <Field
            label="公開ページに出す名前"
            htmlFor="page-title"
            hint="監視対象の内部名とは別にできます"
          >
            <Input
              id="page-title"
              value={title}
              maxLength={60}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>

          <Field label="説明（任意）" htmlFor="page-description">
            <Input
              id="page-description"
              value={description}
              maxLength={200}
              placeholder="障害情報はこのページで随時更新します。"
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>

          <Button
            variant="primary"
            loading={publishPage.isPending}
            onClick={() =>
              void run(
                () => publishPage.mutateAsync({ title, description }),
                '公開ページを発行できませんでした',
              )
            }
          >
            公開ページを発行
          </Button>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-slate-900 px-3 py-2 text-xs text-slate-100">
              {url}
            </code>
            <Button size="sm" onClick={() => void onCopy()}>
              {copied ? 'コピーしました' : 'URL をコピー'}
            </Button>
            {url && (
              <a href={url} target="_blank" rel="noreferrer">
                <Button size="sm" variant="ghost">
                  開く
                </Button>
              </a>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span
              className={
                'rounded-full px-2.5 py-1 text-xs font-medium ' +
                (monitor.status_page_published
                  ? 'bg-up-100 text-up-700'
                  : 'bg-slate-100 text-slate-600')
              }
            >
              {monitor.status_page_published ? '公開中' : '公開停止中'}
            </span>

            <Button
              size="sm"
              loading={setPublished.isPending}
              onClick={() =>
                void run(
                  () => setPublished.mutateAsync(!monitor.status_page_published),
                  '公開設定を変更できませんでした',
                )
              }
            >
              {monitor.status_page_published ? '公開を止める' : '公開を再開'}
            </Button>

            <Button size="sm" variant="danger" onClick={() => setConfirmingRotate(true)}>
              URL を再発行
            </Button>
          </div>

          {/*
            公開を止めるだけでは、再開したときに同じ URL が生きる。
            漏れた URL を無効にしたいなら slug そのものを変えるしかない、という
            使い分けをここで明示しておく。
          */}
          {confirmingRotate && (
            <div className="rounded-md bg-warn-100 px-3 py-2.5 text-xs text-warn-700">
              <p className="font-medium">今の URL は使えなくなります。</p>
              <p className="mt-1">
                すでに共有した相手には、新しい URL を伝え直す必要があります。URL が漏れた場合は、
                公開を止めるだけでは足りません（再開すると同じ URL が生き返るため）。
              </p>
              <div className="mt-2.5 flex gap-2">
                <Button size="sm" onClick={() => setConfirmingRotate(false)}>
                  やめる
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  loading={rotateSlug.isPending}
                  onClick={() =>
                    void run(async () => {
                      await rotateSlug.mutateAsync(undefined);
                      setConfirmingRotate(false);
                    }, 'URL を再発行できませんでした')
                  }
                >
                  再発行する
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {error && <p className="mt-2 text-sm text-down-700">{error}</p>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * 共有の設定。所有者にだけ出す。
 *
 * 画面から隠すのは体験のためで、防御ではない。RLS と SECURITY DEFINER 関数の
 * 入口で所有者かを確かめているので、このコンポーネントを丸ごと消しても
 * 他人が共有設定を触れるようにはならない。
 */
export function SharingCard({ monitor }: { monitor: MonitorOverviewRow }) {
  return (
    <Card className="px-5 py-5">
      <MembersSection monitor={monitor} />
      {monitor.viewer_role === 'owner' && <StatusPageSection monitor={monitor} />}
    </Card>
  );
}
