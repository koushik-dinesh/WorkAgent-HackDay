// Groups for invitations: departments, roles, project teams and custom groups. Department, role
// and project members come from people's department, job title and project membership; custom
// groups have members and nested groups. Directory groups (Entra ID / Google) are read-only.
import { useCallback, useEffect, useState } from 'react';
import {
  addGroupMembers,
  createDepartment,
  createGroup,
  deleteDepartment,
  deleteGroup,
  directoryStatus,
  getGroup,
  listDepartments,
  listGroups,
  removeGroupMember,
  removeNestedGroup,
  renameDepartment,
  searchAttendees,
  syncDirectory,
  updateGroup,
} from '../../api/features.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { TypeBadge } from '../../components/AttendeePicker.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { Button, Card, ErrorAlert, Field, Loading, SuccessAlert, inputClass } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';

const TABS = [
  { key: '', label: 'All' },
  { key: 'department', label: 'Departments' },
  { key: 'role', label: 'Roles' },
  { key: 'project', label: 'Project teams' },
  { key: 'custom', label: 'Custom groups' },
];

export function GroupsPage() {
  const { user } = useAuth();
  const [type, setType] = useState('');
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState(null);
  const load = useCallback(
    () =>
      listGroups(type ? { type } : {})
        .then((d) => {
          setGroups(d.groups);
          setError(null);
        })
        .catch(setError),
    [type],
  );
  useEffect(() => {
    setGroups(null);
    load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Groups</h1>
        <p className="mt-1 text-sm text-slate-500">Invite a whole department, role, project team or your own group instead of adding people one by one.</p>
      </div>
      <SuccessAlert>{notice}</SuccessAlert>
      <CreateGroupForm
        isAdmin={user.role === 'admin'}
        onCreated={(g) => {
          setNotice(`Group “${g.group.name}” created.`);
          load();
          setSelected(g.group.id);
        }}
      />
      <div role="tablist" aria-label="Group types" className="flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={type === t.key} type="button" onClick={() => setType(t.key)} className={`rounded-md px-3 py-1.5 text-sm ${type === t.key ? 'bg-slate-900 text-white' : 'border border-slate-300 bg-white text-slate-700'}`}>
            {t.label}
          </button>
        ))}
      </div>
      <ErrorAlert error={error} />
      {!groups && !error && <Loading />}
      {groups?.length === 0 && <EmptyState title="No groups here">Departments and project teams appear automatically; create a custom group above.</EmptyState>}
      {groups?.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
          <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
            {groups.map((g) => (
              <li key={g.id}>
                <button type="button" onClick={() => setSelected(g.id)} className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm hover:bg-slate-50 ${selected === g.id ? 'bg-slate-50' : ''}`}>
                  <span className="min-w-0">
                    <span className="font-medium text-slate-900">{g.name}</span>
                    {g.source !== 'workagent' && <span className="ml-2 text-xs text-slate-500">{g.source === 'entra' ? 'Entra ID' : 'Google'}</span>}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-slate-500">{g.memberCount ?? '?'} people</span>
                    <TypeBadge kind={g.type} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div>{selected ? <GroupDetail id={selected} onChanged={load} onDeleted={() => { setSelected(null); setNotice('Group deleted.'); load(); }} /> : <p className="text-sm text-slate-500">Select a group to see its members.</p>}</div>
        </div>
      )}
      {user.role === 'admin' && <DepartmentsAdmin onChanged={load} />}
      {user.role === 'admin' && <DirectoryAdmin />}
    </div>
  );
}

function CreateGroupForm({ isAdmin, onCreated }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', type: 'custom', roleValue: '' });
  const [error, setError] = useState(null);
  if (!open) return <Button variant="secondary" onClick={() => setOpen(true)}>New group</Button>;
  async function submit(e) {
    e.preventDefault();
    try {
      onCreated(await createGroup({ name: form.name, description: form.description || null, type: form.type, roleValue: form.type === 'role' ? form.roleValue : null }));
      setOpen(false);
      setForm({ name: '', description: '', type: 'custom', roleValue: '' });
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Card title="New group">
      <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
        <Field label="Name">
          <input className={inputClass} required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        {isAdmin && (
          <Field label="Type" hint="Role groups take everyone with a job title (or app:manager etc.).">
            <select className={inputClass} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="custom">Custom list</option>
              <option value="role">Role</option>
            </select>
          </Field>
        )}
        {form.type === 'role' && (
          <Field label="Job title or WorkAgent role" hint="e.g. QA Lead, or app:manager">
            <input className={inputClass} required value={form.roleValue} onChange={(e) => setForm({ ...form, roleValue: e.target.value })} />
          </Field>
        )}
        <Field label="Description (optional)">
          <input className={inputClass} maxLength={1000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <div className="flex gap-2 md:col-span-2">
          <Button type="submit">Create</Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
        <ErrorAlert error={error} className="md:col-span-2" />
      </form>
    </Card>
  );
}

function GroupDetail({ id, onChanged, onDeleted }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const load = useCallback(
    () =>
      getGroup(id)
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch(setError),
    [id],
  );
  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  useEffect(() => {
    if (q.trim().length < 2) return setFound([]);
    const t = setTimeout(() => searchAttendees(q.trim()).then((d) => setFound(d.results)).catch(() => setFound([])), 200);
    return () => clearTimeout(t);
  }, [q]);

  const act = async (fn) => {
    try {
      setData(await fn());
      setError(null);
      setQ('');
      onChanged();
    } catch (err) {
      setError(err);
    }
  };
  if (error && !data) return <ErrorAlert error={error} />;
  if (!data) return <Loading />;
  const g = data.group;
  const canEdit = g.permissions.canEdit;
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <TypeBadge kind={g.type} /> {g.name}
        </span>
      }
      actions={
        g.permissions.canDelete && (
          <Button
            variant="danger"
            onClick={async () => {
              if (!window.confirm(`Delete the group “${g.name}”?`)) return;
              try {
                await deleteGroup(g.id);
                onDeleted();
              } catch (err) {
                setError(err);
              }
            }}
          >
            Delete
          </Button>
        )
      }
    >
      <div className="space-y-4 text-sm">
        <ErrorAlert error={error} />
        {g.description && <p className="text-slate-600">{g.description}</p>}
        <p className="text-xs text-slate-500">
          Membership: {data.membershipSource}
          {g.lastSyncedAt ? ` · last synced ${formatDateTime(g.lastSyncedAt)}` : ''}
        </p>
        {data.cycles.length > 0 && <p className="text-xs text-amber-700">A nesting loop was cut while resolving this group.</p>}
        {canEdit && g.type === 'custom' && (
          <RenameGroup group={g} onSave={(name) => act(() => updateGroup(g.id, { name }))} />
        )}
        {canEdit && g.type !== 'project' && !(g.type === 'role' && g.roleValue?.startsWith('app:')) && (
          <div>
            <label className="block text-sm font-medium text-slate-700" htmlFor={`add-${g.id}`}>
              Add {g.type === 'custom' ? 'people or groups' : 'people'}
            </label>
            <input id={`add-${g.id}`} type="search" className={`${inputClass} mt-1`} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
            {found.length > 0 && (
              <ul className="mt-1 rounded-md border border-slate-200">
                {found
                  .filter((r) => g.type === 'custom' || r.kind === 'person')
                  .filter((r) => !(r.kind !== 'person' && r.id === g.id))
                  .map((r) => (
                    <li key={`${r.kind}${r.id}`}>
                      <button type="button" className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-slate-50" onClick={() => act(() => addGroupMembers(g.id, r.kind === 'person' ? { userIds: [r.id] } : { childGroupIds: [r.id] }))}>
                        {r.label} <TypeBadge kind={r.kind} />
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        )}
        {data.nestedGroups.length > 0 && (
          <div>
            <h3 className="font-medium">Nested groups</h3>
            <ul className="mt-1 space-y-1">
              {data.nestedGroups.map((n) => (
                <li key={n.id} className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <TypeBadge kind={n.type} /> {n.name}
                  </span>
                  {canEdit && (
                    <button type="button" className="text-xs text-red-700 hover:underline" onClick={() => act(() => removeNestedGroup(g.id, n.id))}>
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <h3 className="font-medium">Members now ({data.members.length})</h3>
          {data.members.length === 0 && <p className="mt-1 text-slate-500">No active members.</p>}
          <ul className="mt-1 grid gap-1 sm:grid-cols-2">
            {data.members.map((m) => {
              const explicit = data.explicitMembers.find((e) => e.id === m.id);
              const removable = canEdit && (g.type !== 'custom' || explicit);
              return (
                <li key={m.id} className="flex items-center justify-between gap-2">
                  <span>
                    {m.fullName}
                    {g.type === 'custom' && !explicit && <span className="ml-1 text-xs text-slate-500">(nested)</span>}
                    {explicit?.source === 'directory' && <span className="ml-1 text-xs text-slate-500">(directory)</span>}
                  </span>
                  {removable && g.type !== 'project' && (
                    <button type="button" aria-label={`Remove ${m.fullName}`} className="text-xs text-red-700 hover:underline" onClick={() => act(() => removeGroupMember(g.id, m.id))}>
                      Remove
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {g.type === 'project' && <p className="mt-2 text-xs text-slate-500">Project team members are managed on the project page.</p>}
        </div>
      </div>
    </Card>
  );
}

function RenameGroup({ group, onSave }) {
  const [name, setName] = useState(group.name);
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(name);
      }}
    >
      <input aria-label="Group name" className={inputClass} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      <Button type="submit" variant="secondary" disabled={!name.trim() || name === group.name}>
        Rename
      </Button>
    </form>
  );
}

function DepartmentsAdmin({ onChanged }) {
  const [depts, setDepts] = useState(null);
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const load = () => listDepartments().then((d) => setDepts(d.departments)).catch(setError);
  useEffect(() => {
    load();
  }, []);
  const act = async (fn) => {
    try {
      await fn();
      setError(null);
      await load();
      onChanged();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Card title="Departments (admin)">
      <ErrorAlert error={error} />
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          act(async () => {
            await createDepartment(name);
            setName('');
          });
        }}
      >
        <input aria-label="New department name" className={inputClass} placeholder="New department" value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" disabled={!name.trim()}>
          Add
        </Button>
      </form>
      <ul className="mt-3 divide-y divide-slate-100 text-sm">
        {(depts ?? []).map((d) => (
          <li key={d.id} className="flex items-center justify-between py-2">
            <span>
              {d.name} <span className="text-xs text-slate-500">· {d.memberCount} people{d.source !== 'workagent' ? ` · synced from ${d.source}` : ''}</span>
            </span>
            <span className="flex gap-3">
              {d.source === 'workagent' && (
                <button type="button" className="text-xs hover:underline" onClick={() => { const n = window.prompt('New name', d.name); if (n) act(() => renameDepartment(d.id, n)); }}>
                  Rename
                </button>
              )}
              <button type="button" className="text-xs text-red-700 hover:underline" onClick={() => window.confirm(`Delete ${d.name}? People keep their accounts.`) && act(() => deleteDepartment(d.id))}>
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-slate-500">Set a person’s department, job title and HR access on the Users page.</p>
    </Card>
  );
}

function DirectoryAdmin() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    directoryStatus().then(setStatus).catch(setError);
  }, []);
  return (
    <Card title="Directory sync (Microsoft Entra ID / Google Workspace)">
      <ErrorAlert error={error} />
      <SuccessAlert>{notice}</SuccessAlert>
      {status?.connections.length === 0 && <p className="text-sm text-slate-500">No Outlook or Google connection. Groups work without a directory; connect one (with directory access) to sync departments, job titles and groups.</p>}
      <ul className="space-y-2 text-sm">
        {status?.connections.map((c) => (
          <li key={c.connectionId} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {c.displayName}
              <span className="block text-xs text-slate-500">{c.problem ?? (c.lastRun ? `Last run ${formatDateTime(c.lastRun.at)}: ${c.lastRun.ok ? `${c.lastRun.counts.usersMatched} people matched, ${c.lastRun.counts.groups} groups` : c.lastRun.problem}` : 'Not synced yet')}</span>
            </span>
            <Button
              variant="secondary"
              disabled={!c.canSync}
              onClick={async () => {
                try {
                  await syncDirectory(c.connectionId);
                  setNotice('Directory sync queued; it runs in the worker.');
                } catch (err) {
                  setError(err);
                }
              }}
            >
              Sync now
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
