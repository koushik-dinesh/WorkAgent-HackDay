// Layout for the signed-out pages (sign in, accept invitation): the form on one side, a short
// statement of what WorkAgent does on the other (hidden on small screens).
import { ListChecks, ShieldCheck, Video } from 'lucide-react';
import { WorkAgentMark } from './icons.jsx';

const POINTS = [
  [Video, 'Meeting intelligence', 'Transcripts become action items, each linked to the line where it was agreed.'],
  [ListChecks, 'One Action Center', 'Commitments from meetings, Teams, Jira, GitHub, Figma and Outlook in one list.'],
  [ShieldCheck, 'Nothing without approval', 'Every write to a connected application is previewed and approved first.'],
];

export function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <main className="flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-sm">
          <div className="flex items-center gap-2.5">
            <WorkAgentMark size={30} />
            <span className="text-base font-semibold tracking-tight text-slate-900">WorkAgent</span>
          </div>
          <h1 className="mt-8 text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </main>
      <aside aria-hidden="true" className="hidden border-l border-line bg-sidebar px-12 lg:flex lg:items-center">
        <div className="max-w-md">
          <p className="text-xs font-medium uppercase tracking-wider text-accent-700">Work intelligence and execution</p>
          <p className="mt-3 text-2xl font-semibold leading-snug tracking-tight text-slate-900">From what was said to what got done.</p>
          <ul className="mt-8 space-y-5">
            {POINTS.map(([Icon, head, text]) => (
              <li key={head} className="flex gap-3.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-accent-700">
                  <Icon size={16} />
                </span>
                <span>
                  <span className="block text-sm font-medium text-slate-900">{head}</span>
                  <span className="mt-0.5 block text-sm text-slate-500">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
