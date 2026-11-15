// Command palette (⌘K / Ctrl+K): jump to any page this person can open, run a quick action, or
// search everything. It lists only the navigation the role already has; nothing here bypasses the
// router's guards or the API's checks.
import { CornerDownLeft, LogOut, Moon, Search, Sparkles, Sun, UserRound } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { navFor } from './nav.js';
import { Dialog, Kbd } from './ui.jsx';

export function CommandPalette({ open, onClose, user, theme, onToggleTheme, onLogout }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef(null);
  const list = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setIndex(0);
    // After the dialog has mounted.
    const t = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const commands = useMemo(() => {
    const pages = navFor(user).flatMap(([group, items]) => items.map((i) => ({ id: `go:${i.to}`, group, label: i.label, icon: i.icon, run: () => navigate(i.to) })));
    const actions = [
      { id: 'new-chat', group: 'Actions', label: 'Ask the AI assistant', icon: Sparkles, run: () => navigate('/assistant') },
      { id: 'profile', group: 'Actions', label: 'Profile and preferences', icon: UserRound, run: () => navigate('/profile') },
      { id: 'theme', group: 'Actions', label: theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme', icon: theme === 'dark' ? Sun : Moon, run: onToggleTheme },
      { id: 'logout', group: 'Actions', label: 'Log out', icon: LogOut, run: onLogout },
    ];
    return [...pages, ...actions];
  }, [user, theme, navigate, onToggleTheme, onLogout]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matched = needle ? commands.filter((c) => `${c.label} ${c.group}`.toLowerCase().includes(needle)) : commands;
    const search = needle ? [{ id: 'search', group: 'Search', label: `Search everything for “${q.trim()}”`, icon: Search, run: () => navigate(`/search?${new URLSearchParams({ q: q.trim() })}`) }] : [];
    return [...search, ...matched];
  }, [q, commands, navigate]);

  useEffect(() => setIndex(0), [q]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [index]);

  function run(cmd) {
    onClose();
    cmd.run();
  }
  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && results[index]) {
      e.preventDefault();
      run(results[index]);
    }
  }

  let lastGroup = null;
  return (
    <Dialog open={open} onClose={onClose} label="Command palette" position="top" className="max-w-xl">
      <div className="flex items-center gap-2.5 border-b border-slate-200 px-4">
        <Search size={16} aria-hidden="true" className="shrink-0 text-slate-400" />
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search or jump to…"
          aria-label="Search or jump to"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          className="h-12 w-full border-0 !bg-transparent text-[15px] outline-none focus:outline-none focus-visible:outline-none"
        />
        <Kbd>esc</Kbd>
      </div>
      <ul ref={list} id="command-palette-list" role="listbox" aria-label="Commands" className="max-h-[52vh] overflow-y-auto p-1.5">
        {results.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-500">Nothing matches.</li>}
        {results.map((c, n) => {
          const heading = c.group !== lastGroup ? c.group : null;
          lastGroup = c.group;
          const Icon = c.icon;
          return (
            <li key={c.id} role="presentation">
              {heading && <p className="px-2.5 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-wider text-slate-400">{heading}</p>}
              <button
                type="button"
                role="option"
                aria-selected={n === index}
                onMouseMove={() => setIndex(n)}
                onClick={() => run(c)}
                className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm ${n === index ? 'bg-slate-100 text-slate-900' : 'text-slate-700'}`}
              >
                <Icon size={15} aria-hidden="true" className="shrink-0 text-slate-500" />
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                {n === index && <CornerDownLeft size={13} aria-hidden="true" className="text-slate-400" />}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-4 border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-500">
        <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> to move</span>
        <span className="flex items-center gap-1"><Kbd>↵</Kbd> to open</span>
      </div>
    </Dialog>
  );
}
