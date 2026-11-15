import { ChevronLeft, ChevronRight, Plus, Users, Video } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listMeetings } from '../../api/meetings.js';
import { EmptyState } from '../../components/EmptyState.jsx';
import { MeetingStatusBadge, meetingStatusLabel } from '../../components/MeetingStatus.jsx';
import { Button, ButtonLink, ErrorAlert, Loading, PageHeader, SearchInput, inputClass, table } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';

const PAGE_SIZE = 25;
const STATUSES = ['draft', 'transcript_ready', 'review_pending', 'approved', 'emails_sent', 'failed'];

export function MeetingsPage() {
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    listMeetings({ status, q: search, limit: PAGE_SIZE, offset })
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [status, search, offset]);

  const filtered = Boolean(status || search);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Meetings"
        description="Create meetings and attach their transcripts."
        actions={
          <ButtonLink to="/admin/meetings/new" variant="primary" icon={Plus}>
            New meeting
          </ButtonLink>
        }
      />

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setSearch(query.trim());
        }}
      >
        <SearchInput className="w-full sm:w-64" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search titles…" aria-label="Search meetings" />
        <select
          value={status}
          onChange={(e) => {
            setOffset(0);
            setStatus(e.target.value);
          }}
          aria-label="Filter by status"
          className={`${inputClass} w-auto min-w-[10rem]`}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {meetingStatusLabel(s)}
            </option>
          ))}
        </select>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      {error && <ErrorAlert error={`Could not load meetings: ${error.message}`} />}
      {!data && !error && <Loading rows={6} />}
      {data?.meetings.length === 0 &&
        (filtered ? (
          <EmptyState title="No matching meetings" icon={Video}>Try a different search or status.</EmptyState>
        ) : (
          <EmptyState title="No meetings yet" icon={Video}>Create your first meeting to attach a transcript.</EmptyState>
        ))}

      {data?.meetings.length > 0 && (
        <>
          <div className={table.wrap}>
            <table className={table.table}>
              <thead className={table.head}>
                <tr>
                  <th className={table.th}>Title</th>
                  <th className={table.th}>When</th>
                  <th className={`${table.th} hidden md:table-cell`}>Project</th>
                  <th className={table.th}>Status</th>
                  <th className={`${table.th} hidden lg:table-cell`}>Participants</th>
                  <th className={`${table.th} hidden lg:table-cell`}>Transcript</th>
                </tr>
              </thead>
              <tbody className={table.body}>
                {data.meetings.map((m) => (
                  <tr key={m.id} className={table.row}>
                    <td className={table.td}>
                      <Link to={`/admin/meetings/${m.id}`} className="font-medium text-slate-900 hover:underline">
                        {m.title}
                      </Link>
                    </td>
                    <td className={`${table.td} whitespace-nowrap text-slate-600`}>{formatDateTime(m.scheduledAt ?? m.createdAt)}</td>
                    <td className={`${table.td} hidden text-slate-600 md:table-cell`}>{m.project?.name ?? <span className="text-slate-400">—</span>}</td>
                    <td className={table.td}>
                      <MeetingStatusBadge status={m.status} />
                    </td>
                    <td className={`${table.td} hidden text-slate-600 lg:table-cell`}>
                      <span className="inline-flex items-center gap-1.5">
                        <Users size={13} aria-hidden="true" className="text-slate-400" />
                        {m.participantCount}
                      </span>
                    </td>
                    <td className={`${table.td} hidden text-slate-600 lg:table-cell`}>
                      {m.transcriptSegmentCount ? `${m.transcriptSegmentCount} segments` : <span className="text-slate-400">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-[13px] text-slate-600">
            <span>
              {offset + 1}–{offset + data.meetings.length} of {data.total}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" icon={ChevronLeft} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                Previous
              </Button>
              <Button variant="secondary" size="sm" disabled={offset + PAGE_SIZE >= data.total} onClick={() => setOffset(offset + PAGE_SIZE)}>
                Next
                <ChevronRight size={14} aria-hidden="true" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
