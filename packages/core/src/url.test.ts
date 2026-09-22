import { describe, expect, it } from 'vitest';

import { InvalidMonitorUrlError } from './errors.js';
import { displayUrl, isValidMonitorUrl, normalizeMonitorUrl } from './url.js';

describe('normalizeMonitorUrl', () => {
  describe('正規化', () => {
    it('スキームが無ければ https:// を補う', () => {
      expect(normalizeMonitorUrl('example.com')).toBe('https://example.com/');
      expect(normalizeMonitorUrl('example.com/health')).toBe('https://example.com/health');
    });

    it('前後の空白を落とす', () => {
      expect(normalizeMonitorUrl('  https://example.com/  ')).toBe('https://example.com/');
    });

    /**
     * フラグメントはサーバーへのリクエストに送られない。
     * 残しておくと「設定した文字列」と「実際に叩く URL」がずれる。
     */
    it('フラグメントを落とす', () => {
      expect(normalizeMonitorUrl('https://example.com/docs#section')).toBe(
        'https://example.com/docs',
      );
    });

    it('クエリ文字列は残す（監視対象の一部になりうる）', () => {
      expect(normalizeMonitorUrl('https://example.com/health?verbose=1')).toBe(
        'https://example.com/health?verbose=1',
      );
    });

    it('ポート付きの URL を受け入れる', () => {
      expect(normalizeMonitorUrl('https://example.com:8443/health')).toBe(
        'https://example.com:8443/health',
      );
    });

    /** 末尾スラッシュの有無で重複登録が起きないよう、URL() の正規化に寄せる。 */
    it('同じ対象を指す表記が同じ文字列になる', () => {
      expect(normalizeMonitorUrl('https://example.com')).toBe(
        normalizeMonitorUrl('https://example.com/'),
      );
      expect(normalizeMonitorUrl('HTTPS://Example.COM/')).toBe('https://example.com/');
    });
  });

  describe('拒否するもの', () => {
    it('空文字', () => {
      expect(() => normalizeMonitorUrl('   ')).toThrow(InvalidMonitorUrlError);
    });

    it('http / https 以外のスキーム', () => {
      expect(() => normalizeMonitorUrl('ftp://example.com')).toThrow(InvalidMonitorUrlError);
      expect(() => normalizeMonitorUrl('file:///etc/passwd')).toThrow(InvalidMonitorUrlError);
      expect(() => normalizeMonitorUrl('javascript://example.com')).toThrow(InvalidMonitorUrlError);
    });

    /** DB に平文で残り、画面にも出てしまう。監視のためにそこまで預かる必要はない。 */
    it('URL に埋め込まれた認証情報', () => {
      expect(() => normalizeMonitorUrl('https://user:pass@example.com/')).toThrow(/認証情報/);
    });

    it('ループバック', () => {
      expect(() => normalizeMonitorUrl('http://localhost:3000/')).toThrow(InvalidMonitorUrlError);
      expect(() => normalizeMonitorUrl('http://127.0.0.1/')).toThrow(InvalidMonitorUrlError);
      expect(() => normalizeMonitorUrl('http://[::1]:8080/')).toThrow(InvalidMonitorUrlError);
      expect(() => normalizeMonitorUrl('http://app.localhost/')).toThrow(InvalidMonitorUrlError);
    });

    it('私有 IPv4 の範囲', () => {
      expect(() => normalizeMonitorUrl('http://10.0.0.5/')).toThrow(InvalidMonitorUrlError);
      expect(() => normalizeMonitorUrl('http://192.168.1.1/')).toThrow(InvalidMonitorUrlError);
      expect(() => normalizeMonitorUrl('http://172.16.0.1/')).toThrow(InvalidMonitorUrlError);
      expect(() => normalizeMonitorUrl('http://172.31.255.255/')).toThrow(InvalidMonitorUrlError);
    });

    it('172.16.0.0/12 の外側は私有ではない', () => {
      expect(isValidMonitorUrl('http://172.15.0.1/')).toBe(true);
      expect(isValidMonitorUrl('http://172.32.0.1/')).toBe(true);
    });

    /** クラウドのメタデータ endpoint（169.254.169.254）を含む範囲。 */
    it('リンクローカル', () => {
      expect(() => normalizeMonitorUrl('http://169.254.169.254/')).toThrow(InvalidMonitorUrlError);
      expect(() => normalizeMonitorUrl('http://[fe80::1]/')).toThrow(InvalidMonitorUrlError);
    });

    it('IPv6 のユニークローカル', () => {
      expect(() => normalizeMonitorUrl('http://[fd00::1]/')).toThrow(InvalidMonitorUrlError);
    });

    it('クラウドのメタデータ用ホスト名', () => {
      expect(() => normalizeMonitorUrl('http://metadata.google.internal/')).toThrow(
        InvalidMonitorUrlError,
      );
    });
  });

  it('公開 URL は通る', () => {
    expect(isValidMonitorUrl('https://stockdesk.example.com/')).toBe(true);
    expect(isValidMonitorUrl('https://8.8.8.8/')).toBe(true);
    expect(isValidMonitorUrl('http://example.co.jp/health')).toBe(true);
  });
});

describe('displayUrl', () => {
  it('スキームと末尾スラッシュを落とす', () => {
    expect(displayUrl('https://example.com/')).toBe('example.com');
    expect(displayUrl('http://example.com/health')).toBe('example.com/health');
  });
});
