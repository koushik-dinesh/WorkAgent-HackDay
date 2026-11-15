// The assistant on every page: a dock that opens over the current page and keeps its conversation
// while you navigate. Same assistant as the Assistant page (closed set of intents, confirmation
// before every write), with examples for the page you are on.
import { Maximize2, Plus, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { AssistantChat } from '../pages/assistant/Assistant.jsx';
import { IconButton, buttonClass } from './ui.jsx';

const KEY = 'workagent.assistant.conversation';
const read = () => {
  try {
    return Number(sessionStorage.getItem(KEY)) || null;
  } catch {
    return null;
  }
};

function examplesFor(path) {
  if (path.startsWith('/actions') || path.startsWith('/approvals')) {
    return ['Create Jira tickets for all approved engineering action items.', 'Email everyone who has pending action items.', 'Which commitments are overdue?'];
  }
  if (path.includes('meetings')) {
    return ['Show me all action items from yesterday’s meetings.', 'Send a summary of the design review to everyone who attended.', 'Book a 30-minute follow-up with everyone who was in this morning’s standup tomorrow at 10am.'];
  }
  if (path.startsWith('/projects') || path.startsWith('/insights')) {
    return ['Who is blocking the Payments project?', 'Compare what was promised in the design review with the actual GitHub progress.', 'Which commitments are overdue?'];
  }
  return ['Show me all action items from yesterday’s meetings.', 'Which commitments are overdue?', 'Schedule a design review with the Payments department Thursday at 4 PM for one hour.'];
}

export function AssistantDock() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState(read);
  useEffect(() => {
    try {
      if (conversationId) sessionStorage.setItem(KEY, String(conversationId));
    } catch {
      /* ignore */
    }
  }, [conversationId]);
  if (pathname.startsWith('/assistant')) return null; // the full page is open already

  return (
    <>
      {open && (
        <div
          role="dialog"
          aria-label="WorkAgent assistant"
          className="fixed inset-x-2 bottom-2 top-16 z-40 flex animate-pop flex-col overflow-hidden rounded-2xl bg-raised shadow-pop sm:inset-x-auto sm:bottom-20 sm:right-5 sm:top-auto sm:h-[min(72vh,42rem)] sm:w-[27rem]"
        >
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
            <span className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <span aria-hidden="true" className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-100 text-accent-700">
                <Sparkles size={14} />
              </span>
              Assistant
            </span>
            <span className="flex items-center gap-0.5">
              <button type="button" className={buttonClass({ variant: 'ghost', size: 'sm' })} onClick={() => setConversationId(null)}>
                <Plus size={13} aria-hidden="true" />
                New
              </button>
              <Link to={conversationId ? `/assistant/${conversationId}` : '/assistant'} className={buttonClass({ variant: 'ghost', size: 'sm' })}>
                <Maximize2 size={12} aria-hidden="true" />
                Full screen
              </Link>
              <IconButton icon={X} label="Close assistant" className="h-7 w-7" size={14} onClick={() => setOpen(false)} />
            </span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col p-3">
            <AssistantChat compact conversationId={conversationId} onConversation={setConversationId} examples={examplesFor(pathname)} />
          </div>
        </div>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? 'Hide the assistant' : 'Ask WorkAgent'}
        title={open ? 'Hide the assistant' : 'Ask WorkAgent'}
        onClick={() => setOpen((x) => !x)}
        className={`fixed bottom-5 right-5 z-40 inline-flex h-11 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-on-primary shadow-pop transition-[transform,background-color] duration-150 hover:bg-primary-hover active:scale-95 ${open ? 'max-sm:hidden' : ''}`}
      >
        {open ? <X size={16} aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
        <span aria-hidden="true" className="hidden sm:inline">{open ? 'Close' : 'Ask WorkAgent'}</span>
      </button>
    </>
  );
}
