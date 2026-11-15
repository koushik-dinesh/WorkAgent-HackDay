// Shared pieces for synced work and WorkAgent records (Phase 4): provider badges, record links,
// source links and labels. One place, so every screen names things the same way.
import { Link } from 'react-router';
import { BrandGlyph } from './icons.jsx';

const PROVIDERS = {
  workagent: { label: 'WorkAgent' },
  github: { label: 'GitHub' },
  jira: { label: 'Jira' },
  microsoft_teams: { label: 'Teams' },
  outlook: { label: 'Outlook' },
  google_calendar: { label: 'Google Calendar' },
  figma: { label: 'Figma' },
  fake: { label: 'Fake' },
};

/** The source application: its brand mark and name in a quiet chip. */
export function ProviderBadge({ provider }) {
  const p = PROVIDERS[provider] ?? { label: provider };
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] font-medium text-slate-700">
      <BrandGlyph provider={provider} size={11} />
      {p.label}
    </span>
  );
}

/** [id, label] for every real source, for filters ("fake" only exists in tests and local checks). */
export const PROVIDER_OPTIONS = Object.entries(PROVIDERS)
  .filter(([id]) => id !== 'fake')
  .map(([id, p]) => [id, p.label]);

export const RECORD_TYPE_LABEL = {
  issue: 'Issue',
  pull_request: 'Pull request',
  commit: 'Commit',
  review: 'Review',
  comment: 'Comment',
  review_comment: 'Review comment',
  repository: 'Repository',
  task: 'Task',
  meeting: 'Meeting',
  project: 'Project',
  person: 'Person',
  message: 'Message',
  email: 'Email',
  calendar_event: 'Calendar event',
  conference: 'Conference',
  design_file: 'Design file',
  version: 'Version',
};
export const recordTypeLabel = (t) => RECORD_TYPE_LABEL[t] ?? (t ? t.replaceAll('_', ' ') : '');

export const LINK_TYPE_LABEL = {
  references: 'references',
  implements: 'implements',
  fixes: 'fixes',
  duplicates: 'duplicates',
  same_as: 'is the same as',
  blocks: 'blocks',
  depends_on: 'depends on',
  discussed_in: 'was discussed in',
  related: 'is related to',
  includes: 'includes',
  tracks: 'tracks',
};
// Reading an incoming link from the other side ("is fixed by", "is blocked by", …).
export const INCOMING_LABEL = {
  references: 'is referenced by',
  implements: 'is implemented by',
  fixes: 'is fixed by',
  duplicates: 'is duplicated by',
  same_as: 'is the same as',
  blocks: 'is blocked by',
  depends_on: 'is needed by',
  discussed_in: 'discussed',
  related: 'is related to',
  includes: 'is included in',
  tracks: 'is tracked by',
};

export const SOURCE_STATUS = {
  current: null,
  deleted: { text: 'Deleted at the source. WorkAgent keeps its history.', cls: 'bg-slate-100 text-slate-700' },
  disconnected: { text: 'The integration is disconnected: this is the last synced version.', cls: 'bg-amber-50 text-amber-900' },
  needs_reconnect: { text: 'The integration needs reconnecting: this may be out of date.', cls: 'bg-amber-50 text-amber-900' },
  access_removed: { text: 'WorkAgent no longer has access to this repository: this is the last synced version.', cls: 'bg-amber-50 text-amber-900' },
  not_syncing: { text: 'This repository is not being synced any more: this may be out of date.', cls: 'bg-amber-50 text-amber-900' },
};

/** Where a summary opens in WorkAgent: the server's href, or the record page for external records. */
export const hrefOf = (s) => s?.href ?? (s?.type === 'external_record' ? `/records/${s.id}` : null);

/** A record's title linking to its WorkAgent page (if any), plus an "open in <provider>" link. */
export function RecordLink({ summary, className = '' }) {
  if (!summary) return <span className="text-slate-500">Unknown record</span>;
  const href = hrefOf(summary);
  return (
    <span className={`min-w-0 break-words ${className}`}>
      {href ? (
        <Link to={href} className="font-medium text-slate-900 hover:underline">
          {summary.title}
        </Link>
      ) : (
        <span className="font-medium text-slate-900">{summary.title}</span>
      )}
      {summary.key && <span className="ml-1 text-slate-500">{summary.key}</span>}
      {summary.url && <SourceLink url={summary.url} provider={summary.provider} className="ml-2" />}
    </span>
  );
}

/** Opens the original in the source application (new tab, no referrer). URLs are http(s) only. */
export function SourceLink({ url, provider, className = '' }) {
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className={`whitespace-nowrap text-xs text-slate-500 underline-offset-2 transition-colors hover:text-slate-900 hover:underline ${className}`}>
      Open in {PROVIDERS[provider]?.label ?? 'source'} ↗
    </a>
  );
}
