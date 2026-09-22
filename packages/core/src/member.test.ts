import { describe, expect, it } from 'vitest';

import { canEditMonitor, canManageMonitor, MEMBER_ROLES } from './member.js';

/**
 * ここで確かめているのは画面の出し分けの規則で、防御そのものではない。
 * 防御は RLS 側にあり、そちらはローカル Supabase に対して確認している。
 *
 * それでもテストを書くのは、この表が DB のポリシーと一対一で対応しており、
 * 片方だけを変えたときに気付ける場所が要るため。
 */
describe('役割ごとにできること', () => {
  const table: Record<(typeof MEMBER_ROLES)[number], { edit: boolean; manage: boolean }> = {
    owner: { edit: true, manage: true },
    editor: { edit: true, manage: false },
    viewer: { edit: false, manage: false },
  };

  for (const role of MEMBER_ROLES) {
    it(`${role}: 設定変更=${table[role].edit} / 共有と削除=${table[role].manage}`, () => {
      expect(canEditMonitor(role)).toBe(table[role].edit);
      expect(canManageMonitor(role)).toBe(table[role].manage);
    });
  }

  /** メンバーでなければ、そもそも行が見えない（RLS）。画面側も同じ結論になる。 */
  it('メンバーでなければ何もできない', () => {
    expect(canEditMonitor(null)).toBe(false);
    expect(canManageMonitor(null)).toBe(false);
    expect(canEditMonitor(undefined)).toBe(false);
    expect(canManageMonitor(undefined)).toBe(false);
  });

  /** editor に削除を許すと、チェック履歴とダウンタイムの記録まで消せてしまう。 */
  it('editor は削除・共有ができない', () => {
    expect(canEditMonitor('editor')).toBe(true);
    expect(canManageMonitor('editor')).toBe(false);
  });
});
