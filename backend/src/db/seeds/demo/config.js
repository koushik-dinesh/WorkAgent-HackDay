// Settings and date helpers of the development dataset. Everything is relative to the anchor day,
// so the same anchor always produces the same data (deterministic) and re-anchoring moves the
// whole three-month history.
//   SEED_ANCHOR_DATE     "today" of the dataset (default 2026-11-15)
//   SEED_COMPANY_DOMAIN  e-mail domain of the people without a given address (reserved domain by
//                        default, so no message can ever reach a real mailbox)
//   SEED_KAVYA_EMAIL     Kavya's address (none was supplied; placeholder by default)
//   SEED_USER_PASSWORD   password of every seeded account (min 12 characters). Unset = accounts
//                        are created without a password and cannot sign in.
export const ANCHOR = process.env.SEED_ANCHOR_DATE || '2026-11-15';
export const DOMAIN = process.env.SEED_COMPANY_DOMAIN || 'arclight.example.com';
export const KAVYA_EMAIL = (process.env.SEED_KAVYA_EMAIL || 'kavya.n@example.com').toLowerCase();
export const PASSWORD = process.env.SEED_USER_PASSWORD || null;
export const SEED_SOURCE = 'demo_seed';
// Office time zone of the company: meetings are written in local time and stored in UTC.
export const OFFICE_OFFSET_MIN = 330; // Asia/Kolkata (+05:30)
export const OFFICE_TZ = 'Asia/Kolkata';

const DAY = 86_400_000;
const anchorMs = Date.parse(`${ANCHOR}T00:00:00Z`);
if (Number.isNaN(anchorMs)) throw new Error(`SEED_ANCHOR_DATE ${ANCHOR} is not a date`);

/** The calendar date (YYYY-MM-DD) `d` days from the anchor. */
export const day = (d) => new Date(anchorMs + d * DAY).toISOString().slice(0, 10);

/** The instant of local office time `hhmm` on day `d` (+ minutes), as a Date (UTC). */
export function at(d, hhmm = '10:00', plusMinutes = 0) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(anchorMs + d * DAY + (h * 60 + m + plusMinutes - OFFICE_OFFSET_MIN) * 60_000);
}

/** Weekday check used by the dataset validation (meetings never fall on a weekend). */
export const isWeekday = (d) => {
  const w = new Date(anchorMs + d * DAY).getUTCDay();
  return w !== 0 && w !== 6;
};

/** Deterministic pseudo-random numbers (mulberry32) for minor variation such as minutes. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable hex id from a string (fake SHAs, ids). */
export function hexOf(s, len = 40) {
  let out = '';
  let h1 = 0x811c9dc5;
  let i = 0;
  while (out.length < len) {
    for (const ch of `${s}:${i}`) h1 = Math.imul(h1 ^ ch.charCodeAt(0), 16777619) >>> 0;
    out += h1.toString(16).padStart(8, '0');
    i += 1;
  }
  return out.slice(0, len);
}
