export function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** ISO string -> value for <input type="datetime-local"> in the browser's timezone. */
export function toLocalInput(value) {
  if (!value) return '';
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value -> ISO string (UTC), or null when empty. */
export const fromLocalInput = (value) => (value ? new Date(value).toISOString() : null);

export function formatTimestamp(seconds) {
  if (seconds === null || seconds === undefined) return '';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Banner text for a failed save: field-level problems are shown next to the fields instead. */
export const errorSummary = (err) =>
  err?.code === 'VALIDATION_ERROR' && err.details?.some((d) => d.field) ? 'Please fix the highlighted fields.' : err;

/** Server validation details -> { field: message } */
export const fieldErrorsFrom = (err) =>
  Object.fromEntries((err?.details ?? []).map((d) => [d.field || '_', d.message]));

/** 'YYYY-MM-DD' -> "Fri, 6 Nov 2026" without timezone shifting. */
export function formatDate(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", else the date. For timestamps in lists. */
export function timeAgo(value, now = Date.now()) {
  if (!value) return '';
  const diff = Math.max(0, now - new Date(value).getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Whole days from today to a 'YYYY-MM-DD' date in the viewer's timezone (negative = past). */
export function daysUntil(isoDate, now = new Date()) {
  if (!isoDate) return null;
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((new Date(y, m - 1, d) - today) / 86_400_000);
}

/** 'YYYY-MM-DD' -> "6 Nov" (adds the year when it is not the current one). */
export function formatShortDate(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(y !== new Date().getFullYear() && { year: 'numeric' }) });
}

/** Day heading for grouped lists: "Today", "Yesterday", else "Mon, 2 Nov". */
export function dayLabel(value, now = new Date()) {
  const d = new Date(value);
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) });
}
