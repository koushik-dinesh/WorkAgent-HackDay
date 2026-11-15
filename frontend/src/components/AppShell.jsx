import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext.jsx';
import { AssistantDock } from './AssistantDock.jsx';
import { NotificationBell } from './NotificationBell.jsx';
import { applyTheme, saveTheme } from './theme.js';

// Grouped navigation per role. The API decides what each person can see on every page; the menu
// only offers the pages that make sense for the role.
const NAV = {
  admin: [
    ['Work', [['/admin', 'Dashboard', true], ['/actions', 'Action Center'], ['/approvals', 'Approvals'], ['/admin/meetings', 'Meetings'], ['/projects', 'Projects'], ['/teams', 'Teams']]],
    ['Intelligence', [['/activity', 'Activity'], ['/suggestions', 'Suggestions'], ['/duplicates', 'Duplicates'], ['/digests', 'Digests'], ['/admin/kpi', 'Work metrics']]],
    ['Tools', [['/assistant', 'Assistant'], ['/meetings/scheduled', 'Schedule'], ['/groups', 'Groups']]],
    ['Administration', [['/admin/users', 'Users'], ['/admin/integrations', 'Integrations'], ['/admin/operations', 'Operations']]],
  ],
  manager: [
    ['Work', [['/insights', 'Insights'], ['/actions', 'Action Center'], ['/approvals', 'Approvals'], ['/my/tasks', 'My tasks'], ['/projects', 'Projects'], ['/teams', 'Teams']]],
    ['Intelligence', [['/activity', 'Activity'], ['/suggestions', 'Suggestions'], ['/duplicates', 'Duplicates'], ['/digests', 'Digests'], ['/my/kpi', 'My metrics']]],
    ['Tools', [['/assistant', 'Assistant'], ['/meetings/scheduled', 'Meetings'], ['/groups', 'Groups']]],
  ],
  employee: [
    ['Work', [['/my/tasks', 'My tasks'], ['/actions', 'Action Center'], ['/insights', 'Insights'], ['/projects', 'Projects']]],
    ['Intelligence', [['/activity', 'Activity'], ['/duplicates', 'Duplicates'], ['/my/kpi', 'My metrics']]],
    ['Tools', [['/assistant', 'Assistant'], ['/meetings/scheduled', 'Meetings'], ['/groups', 'Groups']]],
  ],
};
// People with the HR function (any role) also get the HR views.
const HR_NAV = [
  ['/kpi/hr', 'HR metrics'],
  ['/digests', 'Digests'],
];
export function navFor(user) {
  const groups = (NAV[user.role] ?? NAV.employee).map(([g, items]) => [g, [...items]]);
  if (user.hrAccess || user.role === 'admin') {
    const all = new Set(groups.flatMap(([, items]) => items.map(([to]) => to)));
    const intel = groups.find(([g]) => g === 'Intelligence');
    for (const h of HR_NAV) if (!all.has(h[0])) intel[1].push(h);
  }
  return groups;
}

export function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState(false);
  const [theme, setTheme] = useState(() => (typeof document !== 'undefined' ? applyTheme() : 'light'));
  useEffect(() => setMenu(false), [pathname]);

  function search(e) {
    e.preventDefault();
    if (!q.trim()) return;
    navigate(`/search?${new URLSearchParams({ q: q.trim() })}`);
    setQ('');
  }

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  const nav = (
    <nav aria-label="Main" className="space-y-5">
      {navFor(user).map(([group, items]) => (
        <div key={group}>
          <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{group}</p>
          <ul className="mt-1 space-y-0.5">
            {items.map(([to, label, end]) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={end}
                  className={({ isActive }) => `block rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-slate-100 font-medium text-slate-900' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}
                >
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            <button type="button" className="rounded-md border border-slate-300 px-2 py-1 text-sm lg:hidden" aria-expanded={menu} aria-label="Menu" onClick={() => setMenu((m) => !m)}>
              ☰
            </button>
            <span className="font-semibold tracking-tight text-slate-900">WorkAgent</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <form onSubmit={search} role="search" className="hidden md:block">
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search…"
                aria-label="Search WorkAgent"
                className="w-52 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-slate-500 focus:outline-none"
              />
            </form>
            <button
              type="button"
              aria-label={theme === 'dark' ? 'Use the light theme' : 'Use the dark theme'}
              title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
              className="rounded-md border border-slate-300 px-2 py-1 text-slate-600 hover:bg-slate-50"
              onClick={() => setTheme(saveTheme(theme === 'dark' ? 'light' : 'dark'))}
            >
              {theme === 'dark' ? '☀' : '☾'}
            </button>
            <NotificationBell />
            <NavLink to="/profile" aria-label="Your profile" className="text-slate-600 underline-offset-2 hover:underline">
              <span className="hidden sm:inline">
                {user.fullName} · <span className="capitalize">{user.role}</span>
              </span>
              <span className="sm:hidden">Profile</span>
            </NavLink>
            <button type="button" onClick={handleLogout} className="whitespace-nowrap rounded-md border border-slate-300 px-3 py-1.5 text-slate-700 hover:bg-slate-50">
              Log out
            </button>
          </div>
        </div>
        {menu && <div className="border-t border-slate-200 px-2 py-3 lg:hidden">{nav}</div>}
      </header>
      <div className="mx-auto flex max-w-7xl gap-8 px-4">
        <aside className="hidden w-52 shrink-0 py-8 lg:block">{nav}</aside>
        <main className="min-w-0 flex-1 py-8">
          <Outlet />
        </main>
      </div>
      <AssistantDock />
    </div>
  );
}
