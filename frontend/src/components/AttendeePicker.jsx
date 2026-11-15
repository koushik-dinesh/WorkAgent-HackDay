// Combined attendee picker: people, departments, roles, project teams and custom groups in one
// searchable list with a type badge. A selected group becomes a chip with its live member count
// that expands to its members; any member can be excluded. The server resolves the final list.
import { useEffect, useId, useRef, useState } from 'react';
import { getGroup, searchAttendees } from '../api/features.js';
import { inputClass } from './ui.jsx';

const TYPE_STYLES = {
  person: 'bg-slate-100 text-slate-700',
  department: 'bg-sky-100 text-sky-800',
  role: 'bg-violet-100 text-violet-800',
  project: 'bg-emerald-100 text-emerald-800',
  custom: 'bg-amber-100 text-amber-800',
};
const TYPE_LABEL = { person: 'Person', department: 'Department', role: 'Role', project: 'Project team', custom: 'Group' };

export function TypeBadge({ kind }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${TYPE_STYLES[kind] ?? TYPE_STYLES.custom}`}>{TYPE_LABEL[kind] ?? kind}</span>;
}

/**
 * value: { people: [{ id, label }], groups: [{ id, label, kind, memberCount }], excludedUserIds: [] }
 */
export function AttendeePicker({ value, onChange, disabled = false }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 1) {
      setResults([]);
      return undefined;
    }
    timer.current = setTimeout(() => {
      searchAttendees(q.trim())
        .then((d) => {
          setResults(d.results);
          setError(null);
          setOpen(true);
        })
        .catch(setError);
    }, 200);
    return () => clearTimeout(timer.current);
  }, [q]);

  const isSelected = (r) => (r.kind === 'person' ? value.people.some((p) => p.id === r.id) : value.groups.some((g) => g.id === r.id));
  function add(r) {
    if (isSelected(r)) return;
    if (r.kind === 'person') onChange({ ...value, people: [...value.people, { id: r.id, label: r.label }] });
    else onChange({ ...value, groups: [...value.groups, { id: r.id, label: r.label, kind: r.kind, memberCount: r.memberCount }] });
    setQ('');
    setOpen(false);
  }

  return (
    <div>
      <div className="relative">
        <input
          type="search"
          role="combobox"
          aria-expanded={open && results.length > 0}
          aria-controls={listId}
          aria-label="Search people, departments, roles, project teams and groups"
          placeholder="Search people, departments, roles, teams, groups…"
          className={inputClass}
          value={q}
          disabled={disabled}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
        />
        {open && results.length > 0 && (
          <ul id={listId} role="listbox" className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-md border border-slate-200 bg-white shadow-lg">
            {results.map((r) => (
              <li key={`${r.kind}:${r.id}`} role="option" aria-selected={isSelected(r)}>
                <button type="button" disabled={isSelected(r)} onClick={() => add(r)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-50">
                  <span className="min-w-0">
                    <span className="font-medium text-slate-900">{r.label}</span>
                    {r.detail && <span className="block truncate text-xs text-slate-500">{r.detail}</span>}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {r.memberCount !== undefined && r.memberCount !== null && <span className="text-xs text-slate-500">{r.memberCount} people</span>}
                    <TypeBadge kind={r.kind} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-red-600">Search failed: {error.message}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {value.people.map((p) => (
          <Chip key={`p${p.id}`} kind="person" label={p.label} onRemove={() => onChange({ ...value, people: value.people.filter((x) => x.id !== p.id) })} disabled={disabled} />
        ))}
      </div>
      <div className="mt-2 space-y-2">
        {value.groups.map((g) => (
          <GroupChip
            key={`g${g.id}`}
            group={g}
            excluded={value.excludedUserIds}
            disabled={disabled}
            onToggleExclude={(userId) =>
              onChange({ ...value, excludedUserIds: value.excludedUserIds.includes(userId) ? value.excludedUserIds.filter((x) => x !== userId) : [...value.excludedUserIds, userId] })
            }
            onRemove={() => onChange({ ...value, groups: value.groups.filter((x) => x.id !== g.id) })}
          />
        ))}
      </div>
    </div>
  );
}

function Chip({ kind, label, onRemove, disabled }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white py-1 pl-2 pr-1 text-sm">
      <TypeBadge kind={kind} />
      {label}
      <button type="button" aria-label={`Remove ${label}`} disabled={disabled} onClick={onRemove} className="rounded-full px-1.5 text-slate-500 hover:bg-slate-100">
        ×
      </button>
    </span>
  );
}

function GroupChip({ group, excluded, onToggleExclude, onRemove, disabled }) {
  const [expanded, setExpanded] = useState(false);
  const [members, setMembers] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!expanded || members) return;
    getGroup(group.id)
      .then((d) => setMembers(d.members))
      .catch(setError);
  }, [expanded, members, group.id]);
  const excludedHere = members ? members.filter((m) => excluded.includes(m.id)).length : 0;
  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
        <span className="flex items-center gap-2">
          <TypeBadge kind={group.kind} />
          <span className="font-medium">{group.label}</span>
          <span className="text-xs text-slate-500">{group.memberCount ?? '?'} members{excludedHere ? `, ${excludedHere} excluded` : ''}</span>
        </span>
        <span className="flex gap-2">
          <button type="button" className="text-xs text-slate-700 underline-offset-2 hover:underline" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)}>
            {expanded ? 'Hide members' : 'Show members'}
          </button>
          <button type="button" className="text-xs text-red-700 underline-offset-2 hover:underline" disabled={disabled} onClick={onRemove}>
            Remove
          </button>
        </span>
      </div>
      {expanded && (
        <div className="border-t border-slate-100 px-3 py-2">
          {error && <p className="text-xs text-red-600">{error.message}</p>}
          {!members && !error && <p className="text-xs text-slate-500">Loading members…</p>}
          {members?.length === 0 && <p className="text-xs text-slate-500">This group has no active members.</p>}
          <ul className="grid gap-1 sm:grid-cols-2">
            {members?.map((m) => (
              <li key={m.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={!excluded.includes(m.id)} disabled={disabled} onChange={() => onToggleExclude(m.id)} />
                  <span className={excluded.includes(m.id) ? 'text-slate-400 line-through' : ''}>{m.fullName}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
