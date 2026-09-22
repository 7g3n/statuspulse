import type { IncidentOverviewRow } from '@statuspulse/core';
import { useState } from 'react';

import { Button, cn } from '@/components/ui';
import { formatShortDateTime } from '@/lib/format';

import { useSetIncidentPostmortem } from './api';

/**
 * 障害に残すメモ（ポストモーテム）。
 *
 * 「何が起きて、どう直して、次にどうするか」を人の言葉で残す欄。
 * 稼働率も失敗回数も、**なぜ落ちたか**は教えてくれない。
 * 同じ原因を三度目に踏むかどうかは、そこが書かれているかで決まる。
 *
 * 書くことと公開することを別のフラグにしてある。
 * 社内向けの生々しいメモと、利用者向けの説明は普通は別物で、
 * 1つのフラグにすると「公開したくないから書かない」が起きる。
 */
export function PostmortemEditor({
  incident,
  canEdit,
}: {
  incident: IncidentOverviewRow;
  canEdit: boolean;
}) {
  const save = useSetIncidentPostmortem();

  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(incident.postmortem);
  const [isPublic, setIsPublic] = useState(incident.postmortem_is_public);
  const [error, setError] = useState<string | null>(null);

  const written = incident.postmortem !== '';

  async function onSave() {
    setError(null);
    try {
      await save.mutateAsync({ incidentId: incident.id, text: text.trim(), isPublic });
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存できませんでした');
    }
  }

  if (!editing) {
    if (!written) {
      return canEdit ? (
        <Button
          size="sm"
          variant="ghost"
          className="mt-1.5 -ml-2.5"
          onClick={() => {
            setText('');
            setIsPublic(false);
            setEditing(true);
          }}
        >
          + メモを残す
        </Button>
      ) : null;
    }

    return (
      <div className="mt-2 rounded-md bg-slate-50 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-slate-600">メモ</span>
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[11px]',
              incident.postmortem_is_public
                ? 'bg-brand-100 text-brand-700'
                : 'bg-slate-200 text-slate-600',
            )}
          >
            {incident.postmortem_is_public ? '公開ページに掲載' : '社内のみ'}
          </span>
          {incident.postmortem_updated_at && (
            <span className="text-[11px] text-slate-400">
              {formatShortDateTime(incident.postmortem_updated_at)} 更新
            </span>
          )}
          {canEdit && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => {
                setText(incident.postmortem);
                setIsPublic(incident.postmortem_is_public);
                setEditing(true);
              }}
            >
              編集
            </Button>
          )}
        </div>
        {/* 改行をそのまま出す。箇条書きで書かれることが多い。 */}
        <p className="mt-1.5 whitespace-pre-wrap text-xs text-slate-700">{incident.postmortem}</p>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-md bg-slate-50 px-3 py-3">
      <textarea
        className="block w-full rounded-md border-0 px-3 py-2 text-xs text-slate-900 shadow-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-brand-600"
        rows={5}
        maxLength={4000}
        autoFocus
        placeholder={'何が起きたか\n何をして直したか\n次に同じことを起こさないために何を変えるか'}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />

      <label className="mt-2 flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 size-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
          checked={isPublic}
          onChange={(event) => setIsPublic(event.target.checked)}
        />
        <span className="text-xs text-slate-700">
          公開ステータスページに掲載する
          <span className="mt-0.5 block text-[11px] text-slate-500">
            外部の人が読みます。社内向けの表現が混じっていないか確かめてください。
          </span>
        </span>
      </label>

      {error && <p className="mt-2 text-xs text-down-700">{error}</p>}

      <div className="mt-2.5 flex items-center gap-2">
        <Button size="sm" variant="primary" loading={save.isPending} onClick={() => void onSave()}>
          保存
        </Button>
        <Button size="sm" onClick={() => setEditing(false)}>
          キャンセル
        </Button>
        {written && (
          // 空にすると「未記入」に戻る。DB 側も更新時刻と更新者を NULL に戻す。
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => {
              setText('');
              void save
                .mutateAsync({ incidentId: incident.id, text: '', isPublic: false })
                .then(() => setEditing(false))
                .catch(() => setError('削除できませんでした'));
            }}
          >
            メモを削除
          </Button>
        )}
      </div>
    </div>
  );
}
