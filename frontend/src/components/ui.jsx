// Shared building blocks of the WorkAgent design system (docs/UI_UX_REDESIGN_AUDIT.md §3).
// Colours come from the tokens in index.css; nothing here hard-codes a hex value.
import { AlertCircle, CheckCircle2, ChevronRight, Info, Loader2, Search, TriangleAlert, X } from 'lucide-react';
import { cloneElement, isValidElement, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';

export const cx = (...parts) => parts.filter(Boolean).join(' ');

/* ---------------------------------------------------------------- form controls */

export const inputClass =
  'block w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm shadow-xs transition-colors placeholder:text-slate-400 hover:border-slate-400 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500 disabled:hover:border-slate-300';

const BUTTON = {
  primary: 'bg-primary text-on-primary shadow-xs hover:bg-primary-hover',
  secondary: 'border border-slate-300 bg-white text-slate-800 shadow-xs hover:bg-slate-50 hover:border-slate-400',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  danger: 'border border-red-200 bg-white text-red-700 shadow-xs hover:bg-red-50',
  link: 'text-accent-700 underline-offset-2 hover:underline',
};
const SIZE = { sm: 'h-7 px-2.5 text-xs', md: 'h-8 px-3 text-sm' };

/** Class string for anything that should look like a button (links styled as buttons). */
export function buttonClass({ variant = 'primary', size = 'md', className = '' } = {}) {
  const base =
    variant === 'link'
      ? 'inline-flex items-center gap-1 text-sm font-medium'
      : `inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors duration-150 ${SIZE[size]}`;
  return cx(base, BUTTON[variant], 'disabled:pointer-events-none disabled:opacity-50', className);
}

export function Button({ variant = 'primary', size = 'md', className = '', icon: Icon, loading = false, children, disabled, ...props }) {
  return (
    <button type="button" className={buttonClass({ variant, size, className })} disabled={disabled || loading} {...props}>
      {loading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : Icon ? <Icon size={14} aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/** A router link that looks like a button. */
export function ButtonLink({ variant = 'secondary', size = 'md', className = '', icon: Icon, children, ...props }) {
  return (
    <Link className={buttonClass({ variant, size, className })} {...props}>
      {Icon && <Icon size={14} aria-hidden="true" />}
      {children}
    </Link>
  );
}

/** Square icon-only button. `label` is required: it is the accessible name and the tooltip. */
export function IconButton({ icon: Icon, label, className = '', size = 16, ...props }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-900 disabled:pointer-events-none disabled:opacity-50', className)}
      {...props}
    >
      <Icon size={size} aria-hidden="true" />
    </button>
  );
}

// The label names the control; hint/error are linked with aria-describedby so they don't
// become part of the control's accessible name.
export function Field({ label, error, hint, children }) {
  const baseId = useId();
  const control = isValidElement(children) ? children : null;
  const inputId = control?.props.id ?? `${baseId}-input`;
  const descId = `${baseId}-desc`;
  const message = error || hint;
  return (
    <div>
      <label htmlFor={inputId} className="block text-[13px] font-medium text-slate-700">
        {label}
      </label>
      <div className="mt-1.5">
        {control
          ? cloneElement(control, {
              id: inputId,
              'aria-describedby': message ? descId : undefined,
              'aria-invalid': error ? true : undefined,
            })
          : children}
      </div>
      {message && (
        <p id={descId} className={`mt-1.5 text-xs ${error ? 'text-red-700' : 'text-slate-500'}`}>
          {message}
        </p>
      )}
    </div>
  );
}

/** Search box with a leading icon. Pass the usual input props. */
export function SearchInput({ className = '', inputClassName = '', ...props }) {
  return (
    <div className={cx('relative', className)}>
      <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
      <input type="search" className={cx(inputClass, 'pl-8', inputClassName)} {...props} />
    </div>
  );
}

/** A row of filters that wraps cleanly; children are inputs, selects or <FilterSelect>. */
export function FilterBar({ children, className = '' }) {
  return <div className={cx('flex flex-wrap items-end gap-2', className)}>{children}</div>;
}

/** Compact select for filter bars. `label` is the accessible name (not shown). */
export function FilterSelect({ label, className = '', children, ...props }) {
  return (
    <select aria-label={label} className={cx(inputClass, 'w-auto min-w-[8.5rem] max-w-[13rem] flex-1 sm:flex-none', className)} {...props}>
      {children}
    </select>
  );
}

/* ---------------------------------------------------------------- feedback */

const CALLOUT = {
  info: { cls: 'border-sky-200 bg-sky-50 text-sky-900', Icon: Info },
  success: { cls: 'border-emerald-200 bg-emerald-50 text-emerald-800', Icon: CheckCircle2 },
  warning: { cls: 'border-amber-200 bg-amber-50 text-amber-900', Icon: TriangleAlert },
  danger: { cls: 'border-red-200 bg-red-50 text-red-700', Icon: AlertCircle },
  neutral: { cls: 'border-slate-200 bg-slate-50 text-slate-700', Icon: Info },
};

/** Inline message with an icon. `tone`: info | success | warning | danger | neutral. */
export function Callout({ tone = 'info', className = '', children, ...props }) {
  const { cls, Icon } = CALLOUT[tone] ?? CALLOUT.info;
  return (
    <div className={cx('flex items-start gap-2 rounded-md border px-3 py-2 text-sm', cls, className)} {...props}>
      <Icon size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function ErrorAlert({ error, className = '' }) {
  if (!error) return null;
  return (
    <Callout tone="danger" role="alert" className={className}>
      {typeof error === 'string' || isValidElement(error) ? error : error.message}
    </Callout>
  );
}

export function SuccessAlert({ children }) {
  if (!children) return null;
  return (
    <Callout tone="success" role="status">
      {children}
    </Callout>
  );
}

/** A block of grey placeholder while content loads. Size it with className (h-4 w-32 …). */
export function Skeleton({ className = '' }) {
  return <div aria-hidden="true" className={cx('skeleton', className)} />;
}

/** Loading placeholder: skeleton rows with the label for assistive technology and tests. */
export function Loading({ label = 'Loading…', rows = 3 }) {
  return (
    <div className="space-y-3 py-6">
      <p className="flex items-center gap-2 text-sm text-slate-500">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        {label}
      </p>
      <div className="space-y-2" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="skeleton h-9" style={{ width: `${100 - i * 12}%` }} />
        ))}
      </div>
    </div>
  );
}

/** Animated three-dot "working" indicator (assistant, long operations). */
export function TypingDots({ label = 'Working' }) {
  return (
    <span role="status" aria-label={label} className="inline-flex items-center gap-1">
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1.5 w-1.5 animate-blink rounded-full bg-slate-400" style={{ animationDelay: `${i * 160}ms` }} />
      ))}
    </span>
  );
}

/* ---------------------------------------------------------------- layout */

/**
 * Page title row: title, optional description, actions on the right, and an optional `back`
 * ({ to, label }) link above the title for detail pages.
 */
export function PageHeader({ title, description, actions, back, badge, meta, className = '' }) {
  return (
    <header className={cx('space-y-3', className)}>
      {back && <BackLink to={back.to}>{back.label}</BackLink>}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="break-words text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
            {badge}
          </div>
          {description && <p className="mt-1 max-w-3xl text-sm text-slate-500">{description}</p>}
          {meta && <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-slate-500">{meta}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/** "← Parent" link at the top of detail pages. The arrow is part of the text for screen readers. */
export function BackLink({ to, children, className = '' }) {
  return (
    <Link to={to} className={cx('inline-flex items-center gap-1 text-[13px] text-slate-500 transition-colors hover:text-slate-900', className)}>
      ← {children}
    </Link>
  );
}

export function SectionHeader({ title, description, actions, className = '' }) {
  return (
    <div className={cx('flex flex-wrap items-end justify-between gap-3', className)}>
      <div>
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-slate-500">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Card({ title, description, actions, children, className = '', padded = true, ...props }) {
  return (
    <section className={cx('rounded-xl border border-slate-200 bg-white', className)} {...props}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

const STAT_TONE = { neutral: 'text-slate-900', danger: 'text-red-700', warning: 'text-amber-700', success: 'text-emerald-700', accent: 'text-accent-700' };

/** One figure with a label. `to` makes the whole tile a link; `hint` is a short line below. */
export function StatCard({ label, value, hint, tone = 'neutral', icon: Icon, to, as: Tag = 'div', className = '' }) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500">{label}</span>
        {Icon && <Icon size={14} aria-hidden="true" className="text-slate-400" />}
      </div>
      <div className={cx('mt-1.5 text-2xl font-semibold tabular-nums tracking-tight', STAT_TONE[tone])}>{value ?? '—'}</div>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </>
  );
  const box = 'block rounded-xl border border-slate-200 bg-white px-4 py-3';
  if (to) {
    return (
      <Link to={to} className={cx(box, 'transition-colors duration-150 hover:border-slate-300 hover:bg-slate-50', className)}>
        {body}
      </Link>
    );
  }
  return <Tag className={cx(box, className)}>{body}</Tag>;
}

/** Compact figure for use inside a card (<dl> child): small label above a number. */
export function MiniStat({ label, value }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <dt className="text-[11px] font-medium text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums text-slate-900">{value ?? 0}</dd>
    </div>
  );
}

/* ---------------------------------------------------------------- badges */

const TONE = {
  neutral: 'bg-slate-100 text-slate-700',
  muted: 'bg-slate-100 text-slate-500',
  info: 'bg-sky-100 text-sky-800',
  success: 'bg-emerald-100 text-emerald-800',
  warning: 'bg-amber-100 text-amber-800',
  danger: 'bg-red-100 text-red-700',
  accent: 'bg-accent-100 text-accent-800',
  violet: 'bg-violet-100 text-violet-800',
};
const DOT = {
  neutral: 'bg-slate-400',
  muted: 'bg-slate-300',
  info: 'bg-sky-500',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
  accent: 'bg-accent-500',
  violet: 'bg-violet-500',
};

/** The one status pill. `tone` carries the meaning; `dot` or `icon` adds a leading marker. */
export function Badge({ tone = 'neutral', dot = false, icon: Icon, pulse = false, className = '', children, ...props }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', TONE[tone] ?? TONE.neutral, className)} {...props}>
      {dot && <span aria-hidden="true" className={cx('h-1.5 w-1.5 rounded-full', DOT[tone] ?? DOT.neutral, pulse && 'animate-pulse')} />}
      {Icon && <Icon size={12} aria-hidden="true" className={pulse ? 'animate-pulse' : ''} />}
      {children}
    </span>
  );
}

const STATUS_TONE = {
  draft: 'neutral',
  transcript_ready: 'info',
  failed: 'danger',
  approved: 'success',
  emails_sent: 'success',
  // Project statuses (Phase 2)
  planning: 'info',
  active: 'success',
  on_hold: 'warning',
  completed: 'neutral',
  archived: 'muted',
};

export function StatusBadge({ status }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? 'warning'} dot>
      {status.replaceAll('_', ' ')}
    </Badge>
  );
}

/* ---------------------------------------------------------------- tabs */

/**
 * Underlined tabs. `items`: [{ value, label, count }]. `variant="nav"` renders a <nav> of buttons
 * with aria-current (views that filter a list); `variant="tablist"` renders ARIA tabs.
 */
export function Tabs({ items, value, onChange, label, variant = 'nav', className = '' }) {
  const Wrapper = variant === 'nav' ? 'nav' : 'div';
  return (
    <Wrapper aria-label={label} role={variant === 'tablist' ? 'tablist' : undefined} className={cx('-mb-px flex gap-1 overflow-x-auto border-b border-slate-200', className)}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value || 'all'}
            type="button"
            role={variant === 'tablist' ? 'tab' : undefined}
            aria-selected={variant === 'tablist' ? active : undefined}
            aria-current={variant === 'nav' && active ? 'page' : undefined}
            onClick={() => onChange(item.value)}
            className={cx(
              '-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 pb-2.5 pt-1.5 text-sm transition-colors duration-150',
              active ? 'border-accent-600 font-medium text-slate-900' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800',
            )}
          >
            {item.label}
            {item.count !== undefined && item.count !== null && (
              <span className={cx('rounded-full px-1.5 text-[11px] font-medium tabular-nums', active ? 'bg-accent-100 text-accent-800' : 'bg-slate-100 text-slate-500')}>{item.count}</span>
            )}
          </button>
        );
      })}
    </Wrapper>
  );
}

/* ---------------------------------------------------------------- tables */

/** Class names for data tables, so every table has the same density and header treatment. */
export const table = {
  wrap: 'overflow-x-auto rounded-xl border border-slate-200 bg-white',
  table: 'min-w-full text-left text-sm',
  head: 'border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500',
  th: 'whitespace-nowrap px-4 py-2 font-medium',
  body: 'divide-y divide-slate-100',
  row: 'transition-colors duration-150 hover:bg-slate-50',
  td: 'px-4 py-2.5 align-top',
};

/**
 * Simple data table. `columns`: [{ key, header, cell(row), className, headerClassName }].
 * For tables with bespoke rows, use the `table` class names directly.
 */
export function DataTable({ columns, rows, rowKey = (r) => r.id, label, footer }) {
  return (
    <div className={table.wrap}>
      <table className={table.table} aria-label={label}>
        <thead className={table.head}>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cx(table.th, c.headerClassName)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={table.body}>
          {rows.map((r) => (
            <tr key={rowKey(r)} className={table.row}>
              {columns.map((c) => (
                <td key={c.key} className={cx(table.td, c.className)}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {footer && <div className="border-t border-slate-200 px-4 py-2 text-xs text-slate-500">{footer}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- people */

const AVATAR_TINT = ['bg-accent-100 text-accent-800', 'bg-emerald-100 text-emerald-800', 'bg-amber-100 text-amber-800', 'bg-sky-100 text-sky-800', 'bg-violet-100 text-violet-800', 'bg-rose-100 text-rose-700'];
const initials = (name) =>
  String(name ?? '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';

/** Initials avatar; the tint is derived from the name so a person always has the same colour. */
export function UserAvatar({ name, size = 24, className = '' }) {
  const s = String(name ?? '');
  let hash = 0;
  for (let i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return (
    <span
      aria-hidden="true"
      className={cx('inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold', name ? AVATAR_TINT[hash % AVATAR_TINT.length] : 'bg-slate-100 text-slate-400', className)}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)) }}
    >
      {initials(name)}
    </span>
  );
}

/** Avatar plus name (and an optional second line). */
export function Person({ name, detail, size = 22 }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <UserAvatar name={name} size={size} />
      <span className="min-w-0">
        <span className="block truncate">{name}</span>
        {detail && <span className="block truncate text-xs text-slate-500">{detail}</span>}
      </span>
    </span>
  );
}

/* ---------------------------------------------------------------- data display */

/** Thin horizontal meter (progress, share of a total). `value` and `max` are counts. */
export function Meter({ value, max, tone = 'accent', label, className = '' }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const fill = { accent: 'bg-accent-500', success: 'bg-emerald-500', warning: 'bg-amber-500', danger: 'bg-red-500', neutral: 'bg-slate-400' }[tone];
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className={cx('h-1.5 overflow-hidden rounded-full bg-slate-100', className)}>
      <div className={cx('h-full rounded-full transition-[width] duration-300', fill)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Label/value pairs for property rails and detail cards. `items`: [[label, value]] (falsy values are skipped). */
export function DescriptionList({ items, className = '' }) {
  return (
    <dl className={cx('space-y-3 text-sm', className)}>
      {items.filter(Boolean).map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-slate-500">{label}</dt>
          <dd className="mt-0.5 break-words text-slate-900">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Vertical timeline for history and audit trails.
 * `items`: [{ key, title, detail, at, tone }] — `at` is already formatted.
 */
export function ActivityTimeline({ items, label, as: Tag = 'ol' }) {
  return (
    <Tag aria-label={label} className="relative space-y-4 before:absolute before:bottom-1 before:left-[5px] before:top-1 before:w-px before:bg-slate-200">
      {items.map((it, n) => (
        <li key={it.key ?? n} className="relative flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 pl-6 text-sm">
          <span aria-hidden="true" className={cx('absolute left-0 top-1.5 h-[11px] w-[11px] rounded-full border-2 border-white', DOT[it.tone ?? 'neutral'])} />
          <span className="min-w-0 text-slate-800">
            {it.title}
            {it.detail && <span className="text-slate-500"> {it.detail}</span>}
          </span>
          {it.at && <span className="shrink-0 text-xs text-slate-500">{it.at}</span>}
        </li>
      ))}
    </Tag>
  );
}

/* ---------------------------------------------------------------- overlays */

/** Closes on outside click and Escape. Returns [open, setOpen, ref] — put ref on the wrapper. */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return [open, setOpen, ref];
}

/** Dropdown panel anchored to its (relative) parent. */
export function MenuPanel({ align = 'right', className = '', children, ...props }) {
  return (
    <div role="menu" className={cx('absolute top-full z-50 mt-1.5 min-w-[13rem] origin-top animate-pop rounded-lg bg-raised p-1 shadow-pop', align === 'right' ? 'right-0' : 'left-0', className)} {...props}>
      {children}
    </div>
  );
}

export function MenuItem({ icon: Icon, children, className = '', as: Tag = 'button', danger = false, ...props }) {
  return (
    <Tag
      role="menuitem"
      type={Tag === 'button' ? 'button' : undefined}
      className={cx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors', danger ? 'text-red-700 hover:bg-red-50' : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900', className)}
      {...props}
    >
      {Icon && <Icon size={15} aria-hidden="true" className="shrink-0 opacity-70" />}
      {children}
    </Tag>
  );
}

/** Modal dialog: backdrop, Escape to close, focus moved inside on open. */
export function Dialog({ open, onClose, label, children, className = '', position = 'center' }) {
  const panel = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className={cx('fixed inset-0 z-50 flex justify-center px-4', position === 'top' ? 'items-start pt-[12vh]' : 'items-center')}>
      <div aria-hidden="true" className="absolute inset-0 animate-fade bg-slate-950/40 backdrop-blur-[1px] dark:bg-black/60" onClick={onClose} />
      <div ref={panel} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className={cx('relative max-h-[80vh] w-full max-w-lg animate-pop overflow-hidden rounded-2xl bg-raised shadow-pop focus:outline-none', className)}>
        {children}
      </div>
    </div>
  );
}

/**
 * In-app confirmation. Resolve the decision with onConfirm / onClose.
 * (Existing flows that use window.confirm keep doing so; see the audit's remaining work.)
 */
export function ConfirmDialog({ open, title, children, confirmLabel = 'Confirm', danger = false, busy = false, onConfirm, onClose }) {
  return (
    <Dialog open={open} onClose={onClose} label={title} className="max-w-md">
      <div className="space-y-2 p-5">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <div className="text-sm text-slate-600">{children}</div>
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

/** Keyboard key hint. */
export function Kbd({ children }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-slate-200 bg-slate-50 px-1 text-[11px] font-medium text-slate-500">{children}</kbd>;
}

/** Small dismiss button for chips and panels. */
export function CloseButton({ label = 'Close', onClick, className = '' }) {
  return <IconButton icon={X} label={label} onClick={onClick} className={cx('h-7 w-7', className)} size={14} />;
}

/** "See all" style link with a chevron. */
export function MoreLink({ to, children }) {
  return (
    <Link to={to} className="inline-flex items-center gap-0.5 text-xs font-medium text-slate-500 transition-colors hover:text-slate-900">
      {children}
      <ChevronRight size={13} aria-hidden="true" />
    </Link>
  );
}
