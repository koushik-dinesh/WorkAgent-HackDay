// Duplicate work review: pairs of work items that look like the same work, with the evidence and
// the AI's verdict. "Not a duplicate" removes a pair for good; linking records a "duplicates"
// relationship. Nothing is merged or closed automatically.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { dismissDuplicate, duplicatesStatus, getDuplicate, linkDuplicate, listDuplicates, queryDuplicates, sweepDuplicates } from '../../api/features.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { Button, Card, ErrorAlert, Loading, SuccessAlert, inputClass } from '../../components/ui.jsx';

const TIER = { high: 'bg-red-100 text-red-800', medium: 'bg-amber-100 text-amber-800', low: 'bg-slate-100 text-slate-700' };
const EVIDENCE = { shared_linked_issue: 'Same linked issue', references_each_other: 'Reference each other', shared_files: 'Same files', shared_modules: 'Same modules', shared_components: 'Same components/labels', same_incident: 'Same incident', same_customer: 'Same customer', same_project: 'Same project' };

export function TierBadge({ tier }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TIER[tier]}`}>{tier} confidence</span>;
}

function ItemLine({ item }) {
  const label = `${item.key ? `${item.key} ` : ''}${item.title ?? `${item.type} ${item.id}`}`;
  const where = item.provider === 'workagent' || !item.provider ? (item.type === 'meeting_decision' ? 'Meeting decision' : 'WorkAgent task') : `${item.provider} ${item.recordType ?? ''}`;
  return (
    <div className="min-w-0">
      <p className="truncate font-medium">{item.type === 'external_record' ? <Link to={`/records/${item.id}`} className="hover:underline">{label}</Link> : item.href ? <Link to={item.href} className="hover:underline">{label}</Link> : label}</p>
      <p className="text-xs text-slate-500">
        {where}
        {item.assigneeName ? ` · ${item.assigneeName}` : ''}
      </p>
    </div>
  );
}

export function CandidateCard({ c, onChange }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn) => {
    setBusy(true);
    try {
      onChange((await fn()).candidate);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <TierBadge tier={c.tier} />
          <span className="text-xs text-slate-500">
            {c.method === 'embedding' ? 'semantic' : 'text'} similarity {Math.round(c.similarity * 100)}% · structure {Math.round(c.structuralScore * 100)}%
          </span>
        </span>
        {c.status !== 'open' && <span className="text-xs font-medium text-slate-600">{c.status === 'dismissed' ? 'Not a duplicate' : 'Linked'}</span>}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <ItemLine item={c.a} />
        <ItemLine item={c.b} />
      </div>
      {c.structuralEvidence.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {c.structuralEvidence.map((e) => (
            <li key={e.kind} className="rounded-md bg-slate-100 px-2 py-0.5 text-xs">
              {EVIDENCE[e.kind] ?? e.kind}: {e.values.join(', ')}
            </li>
          ))}
        </ul>
      )}
      {c.verdict && (
        <p className="mt-3">
          <span className="font-medium">AI verdict: {c.verdict === 'same' ? 'same work' : c.verdict === 'related' ? 'related work' : 'coincidental similarity'}.</span> {c.explanation}
        </p>
      )}
      {!c.verdict && c.tier !== 'low' && <p className="mt-3 text-xs text-slate-500">Not adjudicated by AI (not enough structural overlap, or WorkAPI not configured).</p>}
      <ErrorAlert error={error} className="mt-2" />
      {c.status === 'open' && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              const reason = window.prompt('Why is this not a duplicate? (optional)') ?? undefined;
              act(() => dismissDuplicate(c.id, reason || undefined));
            }}
          >
            Not a duplicate
          </Button>
          {c.permissions?.canLink && (
            <Button disabled={busy} onClick={() => act(() => linkDuplicate(c.id))}>
              Link as duplicates
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

export function DuplicatesPage() {
  const { user } = useAuth();
  const [tier, setTier] = useState('high');
  const [status, setStatus] = useState('open');
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => listDuplicates({ tier: tier || undefined, status }).then((d) => setList(d.candidates)).catch(setError), [tier, status]);
  useEffect(() => {
    setList(null);
    load();
  }, [load]);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Duplicate work</h1>
        <p className="mt-1 text-sm text-slate-500">Work in different tools that looks like the same problem. High confidence needs both similar text and shared structure (files, linked issues, incidents).</p>
      </div>
      <AskAnyone />
      <div className="flex flex-wrap gap-3">
        <select aria-label="Confidence" className="rounded-md border border-slate-300 px-2 py-1 text-sm" value={tier} onChange={(e) => setTier(e.target.value)}>
          <option value="high">High confidence</option>
          <option value="medium">Medium (weekly digest)</option>
          <option value="low">Low (similar text only)</option>
          <option value="">All</option>
        </select>
        <select aria-label="Status" className="rounded-md border border-slate-300 px-2 py-1 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">Open</option>
          <option value="dismissed">Not duplicates</option>
          <option value="linked">Linked</option>
          <option value="all">All</option>
        </select>
      </div>
      <ErrorAlert error={error} />
      {!list && !error && <Loading />}
      {list?.length === 0 && <EmptyState title="Nothing here">No candidates you can see at this level.</EmptyState>}
      <div className="space-y-3">
        {list?.map((c) => (
          <CandidateCard key={c.id} c={c} onChange={(n) => setList((l) => l.map((x) => (x.id === n.id ? n : x)))} />
        ))}
      </div>
      {user.role === 'admin' && <DuplicatesAdmin />}
    </div>
  );
}

function AskAnyone() {
  const [text, setText] = useState('');
  const [res, setRes] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Is anyone else working on this?">
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            setRes(await queryDuplicates({ text }));
            setError(null);
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <input aria-label="Describe the work" className={inputClass} placeholder="Describe what you are about to work on…" value={text} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" disabled={busy || text.trim().length < 3}>
          Check
        </Button>
      </form>
      <ErrorAlert error={error} className="mt-2" />
      {res && (
        <div className="mt-3 text-sm">
          {res.results.length === 0 ? (
            <p className="text-slate-500">No similar open work found.</p>
          ) : (
            <ul className="space-y-2">
              {res.results.map((r) => (
                <li key={`${r.item.type}${r.item.id}`} className="flex items-center justify-between gap-3">
                  <ItemLine item={r.item} />
                  <span className="shrink-0 text-xs text-slate-500">{Math.round(r.similarity * 100)}%</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-slate-500">Matching: {res.method === 'embedding' ? 'semantic (embeddings)' : 'text similarity (embeddings not configured)'}.</p>
        </div>
      )}
    </Card>
  );
}

function DuplicatesAdmin() {
  const [s, setS] = useState(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState(null);
  useEffect(() => {
    duplicatesStatus().then(setS).catch(setError);
  }, []);
  return (
    <Card title="Detection (admin)">
      <ErrorAlert error={error} />
      <SuccessAlert>{notice}</SuccessAlert>
      {s && (
        <div className="space-y-2 text-sm">
          <p>Embeddings: {s.embeddings.configured ? `${s.embeddings.provider} ${s.embeddings.model}` : `off — ${s.embeddings.problem} (text similarity is used)`}</p>
          <p>AI adjudication: {s.adjudication.configured ? 'on' : 'off (WorkAPI not configured)'}</p>
          <p>
            Window: {s.windowDays} days · threshold adjustment from feedback: {s.thresholds.adjustment >= 0 ? '+' : ''}
            {s.thresholds.adjustment}
          </p>
          <Button variant="secondary" onClick={() => sweepDuplicates().then(() => setNotice('Sweep queued.')).catch(setError)}>
            Run a full sweep now
          </Button>
        </div>
      )}
    </Card>
  );
}

export function DuplicateDetailPage() {
  const { id } = useParams();
  const [c, setC] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    getDuplicate(id).then((d) => setC(d.candidate)).catch(setError);
  }, [id]);
  if (error) return <ErrorAlert error={error.status === 404 ? 'Not found.' : error} />;
  if (!c) return <Loading />;
  return (
    <div className="space-y-4">
      <Link to="/duplicates" className="text-sm text-slate-600 hover:underline">
        ← Duplicate work
      </Link>
      <CandidateCard c={c} onChange={setC} />
    </div>
  );
}

/** Inline alert on an item's page: open high-confidence duplicates of it. */
export function DuplicateAlerts({ itemType, itemId }) {
  const [list, setList] = useState([]);
  useEffect(() => {
    listDuplicates({ itemType, itemId, tier: 'high', status: 'open' })
      .then((d) => setList(d.candidates))
      .catch(() => setList([]));
  }, [itemType, itemId]);
  if (!list.length) return null;
  return (
    <div role="status" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
      <p className="font-medium">Possible duplicate work</p>
      <ul className="mt-1 space-y-1">
        {list.map((c) => {
          const other = c.a.type === itemType && c.a.id === Number(itemId) ? c.b : c.a;
          return (
            <li key={c.id}>
              <Link to={`/duplicates/${c.id}`} className="underline">
                {other.key ? `${other.key} ` : ''}
                {other.title}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
