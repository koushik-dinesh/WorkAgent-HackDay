// The application shell: grouped sidebar (collapsible, a drawer on small screens), a slim header
// with breadcrumbs, the command palette trigger, notifications, theme and the profile menu, and
// the assistant dock.
import { ChevronRight, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Search, Sun, UserRound, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext.jsx';
import { AssistantDock } from './AssistantDock.jsx';
import { CommandPalette } from './CommandPalette.jsx';
import { WorkAgentMark } from './icons.jsx';
import { crumbsFor, isActive, navFor } from './nav.js';
import { NotificationBell } from './NotificationBell.jsx';
import { applyTheme, saveTheme } from './theme.js';
import { IconButton, Kbd, MenuItem, MenuPanel, UserAvatar, usePopover } from './ui.jsx';

export { navFor };

const COLLAPSE_KEY = 'workagent.sidebar.collapsed';
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
};
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');

function SidebarNav({ user, pathname, collapsed = false }) {
  return (
    <nav aria-label="Main" className={`flex-1 overflow-y-auto overflow-x-hidden pb-4 ${collapsed ? 'px-2' : 'px-3'}`}>
      {navFor(user).map(([group, items], g) => (
        <div key={group} className={g === 0 ? '' : 'mt-5'}>
          {collapsed ? (
            g > 0 && <div aria-hidden="true" className="mx-2 mb-3 border-t border-slate-200" />
          ) : (
            <p className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-400">{group}</p>
          )}
          <ul className="space-y-px">
            {items.map((item) => {
              const active = isActive(item, pathname);
              const Icon = item.icon;
              return (
                <li key={item.to} className="group relative">
                  <NavLink
                    to={item.to}
                    aria-current={active ? 'page' : undefined}
                    aria-label={collapsed ? item.label : undefined}
                    className={`flex h-8 items-center gap-2.5 rounded-md text-[13px] transition-colors duration-150 ${collapsed ? 'justify-center px-0' : 'px-2'} ${
                      active ? 'bg-slate-200/70 font-medium text-slate-900' : 'text-slate-600 hover:bg-slate-200/50 hover:text-slate-900'
                    }`}
                  >
                    <Icon size={16} aria-hidden="true" className={`shrink-0 ${active ? 'text-accent-700' : 'text-slate-500'}`} />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </NavLink>
                  {collapsed && (
                    <span role="tooltip" className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 hidden -translate-y-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-slate-50 shadow-pop group-focus-within:block group-hover:block">
                      {item.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Brand({ collapsed }) {
  return (
    <Link to="/" aria-label="WorkAgent home" className="flex items-center gap-2.5 rounded-md">
      <WorkAgentMark size={26} />
      {!collapsed && <span className="text-[15px] font-semibold tracking-tight text-slate-900">WorkAgent</span>}
    </Link>
  );
}

function Breadcrumbs({ user, pathname }) {
  const crumbs = crumbsFor(user, pathname);
  if (!crumbs.length) return <span />;
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 text-[13px]">
        {crumbs.map((c, n) => {
          const last = n === crumbs.length - 1;
          return (
            <li key={`${c.label}-${n}`} className={`flex min-w-0 items-center gap-1 ${last ? '' : 'hidden sm:flex'}`}>
              {n > 0 && <ChevronRight size={13} aria-hidden="true" className="hidden shrink-0 text-slate-300 sm:block" />}
              {c.to ? (
                <Link to={c.to} className="truncate text-slate-500 transition-colors hover:text-slate-900">
                  {c.label}
                </Link>
              ) : (
                <span aria-current={last ? 'page' : undefined} className={`truncate ${last ? 'font-medium text-slate-900' : 'text-slate-500'}`}>
                  {c.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function ProfileMenu({ user, theme, onToggleTheme, onLogout }) {
  const [open, setOpen, ref] = usePopover();
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname, setOpen]);
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label="Account menu" onClick={() => setOpen((o) => !o)} className="flex items-center rounded-full transition-shadow hover:ring-2 hover:ring-slate-200">
        <UserAvatar name={user.fullName} size={28} />
      </button>
      {open && (
        <MenuPanel className="w-60">
          <div className="flex items-center gap-2.5 px-2 py-2">
            <UserAvatar name={user.fullName} size={32} />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-slate-900">{user.fullName}</p>
              <p className="truncate text-xs text-slate-500">
                {user.email ? `${user.email} · ` : ''}
                <span className="capitalize">{user.role}</span>
              </p>
            </div>
          </div>
          <div className="my-1 border-t border-slate-200" />
          <MenuItem as={Link} to="/profile" icon={UserRound}>
            Profile and preferences
          </MenuItem>
          <MenuItem icon={theme === 'dark' ? Sun : Moon} onClick={onToggleTheme}>
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </MenuItem>
          <div className="my-1 border-t border-slate-200" />
          <MenuItem icon={LogOut} onClick={onLogout}>
            Log out
          </MenuItem>
        </MenuPanel>
      )}
    </div>
  );
}

export function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [palette, setPalette] = useState(false);
  const [theme, setTheme] = useState(() => (typeof document !== 'undefined' ? applyTheme() : 'light'));
  useEffect(() => setDrawer(false), [pathname]);

  // ⌘K / Ctrl+K opens the command palette from anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const toggleTheme = useCallback(() => setTheme((t) => saveTheme(t === 'dark' ? 'light' : 'dark')), []);
  const handleLogout = useCallback(async () => {
    await logout();
    navigate('/login', { replace: true });
  }, [logout, navigate]);
  const closePalette = useCallback(() => setPalette(false), []);

  function toggleCollapsed() {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        /* private mode: lasts for this page only */
      }
      return !c;
    });
  }

  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-raised focus:px-3 focus:py-2 focus:text-sm focus:shadow-pop">
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-line bg-sidebar transition-[width] duration-200 ease-out lg:flex ${collapsed ? 'w-14' : 'w-60'}`}>
        <div className={`flex h-13 shrink-0 items-center ${collapsed ? 'justify-center' : 'justify-between px-4'}`} style={{ height: '3.25rem' }}>
          <Brand collapsed={collapsed} />
        </div>
        <SidebarNav user={user} pathname={pathname} collapsed={collapsed} />
        <div className={`shrink-0 border-t border-line p-2 ${collapsed ? 'flex justify-center' : ''}`}>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
            title={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
            className={`flex h-8 items-center gap-2.5 rounded-md text-[13px] text-slate-500 transition-colors duration-150 hover:bg-slate-200/50 hover:text-slate-900 ${collapsed ? 'w-8 justify-center' : 'w-full px-2'}`}
          >
            {collapsed ? <PanelLeftOpen size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div aria-hidden="true" className="absolute inset-0 animate-fade bg-slate-950/40 dark:bg-black/60" onClick={() => setDrawer(false)} />
          <aside role="dialog" aria-modal="true" aria-label="Navigation" className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] animate-slide-in flex-col border-r border-line bg-sidebar shadow-pop">
            <div className="flex shrink-0 items-center justify-between px-4" style={{ height: '3.25rem' }}>
              <Brand />
              <IconButton icon={X} label="Close the menu" onClick={() => setDrawer(false)} />
            </div>
            <SidebarNav user={user} pathname={pathname} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex shrink-0 items-center gap-3 border-b border-line bg-canvas/85 px-4 backdrop-blur-md sm:px-6" style={{ height: '3.25rem' }}>
          <IconButton icon={Menu} label="Menu" aria-expanded={drawer} className="-ml-1.5 lg:hidden" onClick={() => setDrawer(true)} />
          <Breadcrumbs user={user} pathname={pathname} />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setPalette(true)}
              aria-label="Search or jump to a page"
              aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}
              className="mr-1 hidden h-8 w-56 items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 text-[13px] text-slate-400 shadow-xs transition-colors duration-150 hover:border-slate-300 hover:text-slate-600 md:flex xl:w-64"
            >
              <Search size={14} aria-hidden="true" />
              <span className="flex-1 text-left">Search or jump to…</span>
              <span aria-hidden="true" className="flex items-center gap-0.5">
                <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
                <Kbd>K</Kbd>
              </span>
            </button>
            <IconButton icon={Search} label="Search or jump to a page" className="md:hidden" onClick={() => setPalette(true)} />
            <NotificationBell />
            <IconButton icon={theme === 'dark' ? Sun : Moon} label={theme === 'dark' ? 'Use the light theme' : 'Use the dark theme'} onClick={toggleTheme} />
            <span className="ml-1.5">
              <ProfileMenu user={user} theme={theme} onToggleTheme={toggleTheme} onLogout={handleLogout} />
            </span>
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[82rem] flex-1 px-4 pb-24 pt-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>

      <CommandPalette open={palette} onClose={closePalette} user={user} theme={theme} onToggleTheme={toggleTheme} onLogout={handleLogout} />
      <AssistantDock />
    </div>
  );
}
