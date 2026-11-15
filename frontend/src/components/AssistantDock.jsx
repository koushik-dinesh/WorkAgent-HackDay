// The assistant on every page: a dock that opens over the current page and keeps its conversation
// while you navigate. Same assistant as the Assistant page (closed set of intents, confirmation
// before every write), with examples for the page you are on.
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { AssistantChat } from '../pages/assistant/Assistant.jsx';

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
        <div role="dialog" aria-label="WorkAgent assistant" className="fixed bottom-20 right-4 z-40 flex h-[min(70vh,40rem)] w-[min(28rem,calc(100vw-2rem))] flex-col gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-3 shadow-2xl">
          <div className="flex items-center justify-between px-1">
            <span className="text-sm font-semibold text-slate-900">Assistant</span>
            <span className="flex items-center gap-3 text-xs">
              <button type="button" className="text-slate-600 hover:underline" onClick={() => setConversationId(null)}>
                New
              </button>
              <Link to={conversationId ? `/assistant/${conversationId}` : '/assistant'} className="text-slate-600 hover:underline">
                Full screen
              </Link>
              <button type="button" aria-label="Close assistant" className="text-slate-600 hover:text-slate-900" onClick={() => setOpen(false)}>
                ✕
              </button>
            </span>
          </div>
          <AssistantChat compact conversationId={conversationId} onConversation={setConversationId} examples={examplesFor(pathname)} />
        </div>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? 'Hide the assistant' : 'Ask WorkAgent'}
        onClick={() => setOpen((x) => !x)}
        className="fixed bottom-4 right-4 z-40 rounded-full bg-slate-900 px-4 py-3 text-sm font-medium text-white shadow-lg hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900"
      >
        {open ? 'Close' : 'Ask WorkAgent'}
      </button>
    </>
  );
}
