import { Bell } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { NavLink } from 'react-router';
import { getUnreadCount } from '../api/me.js';

const POLL_MS = 60_000;
const CHANGED = 'workagent:notifications-changed';

/** Tells the badge to re-read the count (the Notifications page calls this after marking read). */
export const announceNotificationsChanged = () => window.dispatchEvent(new Event(CHANGED));

/**
 * Header link to the notifications with the unread count. Reads the count once a minute while the
 * tab is visible, when the tab comes back, and when this tab changed something; a failed read just
 * keeps the last number (a 401 signs out through the API client).
 */
export function NotificationBell() {
  const [unread, setUnread] = useState(0);
  const refresh = useCallback(() => {
    if (document.visibilityState === 'hidden') return;
    getUnreadCount()
      .then((d) => setUnread(d.unread))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    window.addEventListener(CHANGED, refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener(CHANGED, refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [refresh]);

  return (
    <NavLink
      to="/notifications"
      aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
      title="Notifications"
      className={({ isActive }) =>
        `relative inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors duration-150 hover:bg-slate-100 hover:text-slate-900 ${isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-500'}`
      }
    >
      <Bell size={16} aria-hidden="true" />
      {unread > 0 && (
        <span aria-hidden="true" className="absolute -right-1 -top-1 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] font-semibold leading-4 text-white ring-2 ring-canvas">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </NavLink>
  );
}
