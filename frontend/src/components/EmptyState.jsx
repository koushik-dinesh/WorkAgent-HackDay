import { Inbox } from 'lucide-react';

/** Empty state: a quiet icon, a title and one line of guidance; `action` is an optional button/link. */
export function EmptyState({ title, children, icon: Icon = Inbox, action }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <span aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        <Icon size={18} />
      </span>
      <h2 className="mt-3 text-sm font-medium text-slate-900">{title}</h2>
      <p className="mt-1 max-w-md text-sm text-slate-500">{children}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
