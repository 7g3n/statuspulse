/**
 * 表示のための整形。判定は含まない（判定は @statuspulse/core にある）。
 *
 * 時刻はすべて日本時間で表示する。DB は UTC で持っているので、
 * 画面に出す直前にここで揃える。「3時に落ちた」が UTC と JST で9時間ずれると、
 * ログや記憶との突き合わせができなくなる。
 */

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const TIME_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return DATE_TIME_FORMAT.format(new Date(iso));
}

export function formatShortDateTime(iso: string | null): string {
  if (!iso) return '—';
  return TIME_FORMAT.format(new Date(iso));
}

/**
 * 「3分前」のような相対表記。
 *
 * 監視の画面では絶対時刻より「どれくらい前か」の方が先に知りたい
 * （最終チェックが5分前なのか3時間前なのかで、見ている数字の意味が変わる）。
 * 絶対時刻は title 属性で併記し、必要なときに読めるようにしておく。
 */
export function formatRelativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';

  const diffSeconds = Math.round((now - Date.parse(iso)) / 1000);

  if (diffSeconds < 0) return 'たった今';
  if (diffSeconds < 60) return `${diffSeconds}秒前`;

  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}分前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;

  const days = Math.floor(hours / 24);
  return `${days}日前`;
}

/** 「2時間34分」のような経過時間。ダウン継続時間・正常継続時間の表示に使う。 */
export function formatDuration(fromIso: string | null, now = Date.now()): string {
  if (!fromIso) return '—';

  const totalMinutes = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 60000));
  if (totalMinutes < 60) return `${totalMinutes}分`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes === 0 ? `${hours}時間` : `${hours}時間${minutes}分`;

  const days = Math.floor(hours / 24);
  return `${days}日${hours % 24}時間`;
}
