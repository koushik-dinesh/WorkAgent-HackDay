// Brand marks and source icons. One place, so every screen shows the same mark for an application.
// GitHub, Jira, Figma, Google Calendar, Google Meet and Gmail use the official glyphs from the
// simple-icons package. Microsoft does not license its marks through that package, so Teams and
// Outlook are simplified marks in their brand colours; Vexa is WorkAgent's own monogram for it.
import { Bot, CalendarDays, FileText, Mail, MessageSquare, PenLine, Sparkles, Video } from 'lucide-react';
import { siFigma, siGithub, siGmail, siGooglecalendar, siGooglemeet, siJira } from 'simple-icons';

function Glyph({ icon, size, mono = false }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill={mono ? 'currentColor' : `#${icon.hex}`}>
      <path d={icon.path} />
    </svg>
  );
}

function TeamsMark({ size }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <circle cx="24.5" cy="9.5" r="3.5" fill="#7b83eb" />
      <rect x="19" y="14" width="11" height="11" rx="3" fill="#7b83eb" />
      <rect x="2" y="7" width="19" height="19" rx="3" fill="#5059c9" />
      <path fill="#fff" d="M6.5 11.5h10v2.3h-3.7V22h-2.6v-8.2H6.5z" />
    </svg>
  );
}

function OutlookMark({ size }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <rect x="12" y="6" width="18" height="20" rx="2.5" fill="#28a8ea" />
      <path d="M12 12h18v11.5a2.5 2.5 0 0 1-2.5 2.5H12z" fill="#0078d4" />
      <rect x="2" y="9" width="16" height="16" rx="2.5" fill="#0a5cab" />
      <ellipse cx="10" cy="17" rx="3.4" ry="4.1" fill="none" stroke="#fff" strokeWidth="2" />
    </svg>
  );
}

function VexaMark({ size }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#17181b" />
      <path d="M9 11l7 11 7-11" fill="none" stroke="#fff" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WorkAgentGlyph({ size }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7l3.5 10L12 9l4.5 8L20 7" />
    </svg>
  );
}

/** The WorkAgent mark: a rounded accent tile with the "W" stroke. */
export function WorkAgentMark({ size = 24, className = '' }) {
  return (
    <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center rounded-[28%] bg-primary text-on-primary ${className}`} style={{ width: size, height: size }}>
      <WorkAgentGlyph size={Math.round(size * 0.66)} />
    </span>
  );
}

// provider id -> { label, render(size) }. `mono` glyphs follow the text colour (GitHub is black/white).
const BRANDS = {
  github: { label: 'GitHub', render: (s) => <Glyph icon={siGithub} size={s} mono /> },
  jira: { label: 'Jira', render: (s) => <Glyph icon={siJira} size={s} /> },
  figma: { label: 'Figma', render: (s) => <Glyph icon={siFigma} size={s} /> },
  google_calendar: { label: 'Google Calendar', render: (s) => <Glyph icon={siGooglecalendar} size={s} /> },
  google_meet: { label: 'Google Meet', render: (s) => <Glyph icon={siGooglemeet} size={s} /> },
  gmail: { label: 'Gmail', render: (s) => <Glyph icon={siGmail} size={s} /> },
  microsoft_teams: { label: 'Microsoft Teams', render: (s) => <TeamsMark size={s} /> },
  outlook: { label: 'Outlook', render: (s) => <OutlookMark size={s} /> },
  vexa: { label: 'Vexa', render: (s) => <VexaMark size={s} /> },
  workagent: { label: 'WorkAgent', render: (s) => <span className="text-accent-700"><WorkAgentGlyph size={s} /></span> },
};
const ALIASES = { teams: 'microsoft_teams', microsoft: 'microsoft_teams', google: 'google_calendar', email: 'outlook' };
const brandOf = (provider) => BRANDS[provider] ?? BRANDS[ALIASES[provider]];

/** The bare brand glyph for a provider id (falls back to nothing). Decorative: label it nearby. */
export function BrandGlyph({ provider, size = 14 }) {
  return brandOf(provider)?.render(size) ?? null;
}

/**
 * Brand mark in a neutral tile, for integration cards and lists. `title` gives it an accessible
 * name (e.g. "Figma logo"); without it the icon is decorative.
 */
export function IntegrationIcon({ provider, size = 36, title, className = '' }) {
  const brand = brandOf(provider);
  const inner = Math.round(size * 0.56);
  return (
    <span
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-900 ${className}`}
      style={{ width: size, height: size }}
    >
      {brand ? brand.render(provider === 'vexa' ? Math.round(size * 0.7) : inner) : <span className="text-xs font-semibold uppercase text-slate-500">{String(provider ?? '?').slice(0, 2)}</span>}
    </span>
  );
}

// Where an action item came from (action_items.source) -> icon.
const SOURCE = {
  meeting: { Icon: Video },
  teams_message: { provider: 'microsoft_teams' },
  jira_comment: { provider: 'jira' },
  github_comment: { provider: 'github' },
  figma_comment: { provider: 'figma' },
  outlook_email: { provider: 'outlook' },
  manual: { Icon: PenLine },
  assistant: { Icon: Sparkles },
};
// Record types without a provider.
const RECORD = { meeting: Video, calendar_event: CalendarDays, email: Mail, message: MessageSquare, bot: Bot };

/** Small icon for an action item's source or a provider id; decorative (the label sits next to it). */
export function SourceIcon({ source, size = 14, className = '' }) {
  const s = SOURCE[source];
  const provider = s?.provider ?? (brandOf(source) ? source : null);
  const Icon = s?.Icon ?? RECORD[source] ?? FileText;
  return (
    <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center text-slate-500 ${className}`} style={{ width: size, height: size }}>
      {provider ? <BrandGlyph provider={provider} size={size} /> : <Icon size={size} />}
    </span>
  );
}

export const brandLabel = (provider) => brandOf(provider)?.label ?? provider;
