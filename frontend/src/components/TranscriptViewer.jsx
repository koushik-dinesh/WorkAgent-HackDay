import { useEffect, useMemo, useState } from 'react';
import { formatTimestamp } from '../utils/format.js';
import { SearchInput } from './ui.jsx';

const SPEAKER_COLORS = [
  'text-sky-700',
  'text-violet-700',
  'text-emerald-700',
  'text-amber-700',
  'text-rose-700',
  'text-teal-700',
];

// Renders segments as plain text (React escapes it), never as HTML.
// `highlight` = { segmentId, nonce }: scrolls to and highlights that segment (from evidence links).
export function TranscriptViewer({ segments, highlight }) {
  const [filter, setFilter] = useState('');

  const colorFor = useMemo(() => {
    const speakers = [...new Set(segments.map((s) => s.speaker).filter(Boolean))];
    return (speaker) => SPEAKER_COLORS[speakers.indexOf(speaker) % SPEAKER_COLORS.length];
  }, [segments]);

  useEffect(() => {
    if (!highlight?.segmentId) return;
    setFilter('');
    // Wait for the unfiltered list to render, then bring the segment into view.
    requestAnimationFrame(() => {
      const el = document.getElementById(`segment-${highlight.segmentId}`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.focus({ preventScroll: true });
    });
  }, [highlight]);

  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? segments.filter((s) => s.text.toLowerCase().includes(needle) || s.speaker?.toLowerCase().includes(needle))
    : segments;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SearchInput className="w-full max-w-xs" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search transcript…" aria-label="Search transcript" />
        {needle && <span className="text-xs text-slate-500">{visible.length} of {segments.length} segments</span>}
      </div>
      <ol className="max-h-[32rem] divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
        {visible.map((s) => (
          <li
            key={s.id}
            id={`segment-${s.id}`}
            tabIndex={-1}
            className={`grid grid-cols-[3.25rem_1fr] gap-3 px-3.5 py-2.5 text-sm transition-colors duration-150 focus:outline-none ${highlight?.segmentId === s.id ? 'bg-amber-50 ring-1 ring-inset ring-amber-300' : 'hover:bg-slate-50'}`}
          >
            <span className="pt-0.5 font-mono text-xs text-slate-400">{formatTimestamp(s.startSec) || '—'}</span>
            <div className="min-w-0">
              <span className={`font-medium ${s.speaker ? colorFor(s.speaker) : 'italic text-slate-400'}`}>
                {s.speaker ?? 'Unknown speaker'}
              </span>
              {s.language && <span className="ml-2 rounded bg-slate-100 px-1 text-[10px] uppercase text-slate-500">{s.language}</span>}
              <p className="mt-0.5 whitespace-pre-wrap break-words leading-6 text-slate-800">{s.text}</p>
            </div>
          </li>
        ))}
        {visible.length === 0 && <li className="px-3 py-4 text-sm text-slate-500">No segments match.</li>}
      </ol>
    </div>
  );
}
