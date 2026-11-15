// Navigation for the sidebar, the command palette and the breadcrumbs.
// Grouped per role. The API decides what each person can see on every page; the menu only offers
// the pages that make sense for the role, so nobody is shown a link they cannot open.
import {
  Activity,
  BarChart3,
  Blocks,
  CalendarClock,
  CheckSquare,
  CopyCheck,
  FolderKanban,
  Gauge,
  GitPullRequestArrow,
  LayoutDashboard,
  LineChart,
  ListChecks,
  Newspaper,
  ServerCog,
  Settings2,
  ShieldCheck,
  Sparkles,
  UserCog,
  Users,
  UsersRound,
  Video,
} from 'lucide-react';

const I = {
  overviewAdmin: { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
  overview: { to: '/overview', label: 'Overview', icon: LayoutDashboard },
  myTasks: { to: '/my/tasks', label: 'My tasks', icon: CheckSquare },
  actions: { to: '/actions', label: 'Action Center', icon: ListChecks, except: ['/actions/settings'] },
  approvals: { to: '/approvals', label: 'Approvals', icon: ShieldCheck },
  meetingsAdmin: { to: '/admin/meetings', label: 'Meetings', icon: Video },
  digests: { to: '/digests', label: 'Digests', icon: Newspaper },
  insights: { to: '/insights', label: 'Insights', icon: LineChart },
  activity: { to: '/activity', label: 'Activity', icon: Activity },
  suggestions: { to: '/suggestions', label: 'Suggestions', icon: GitPullRequestArrow },
  duplicates: { to: '/duplicates', label: 'Duplicates', icon: CopyCheck },
  kpiAdmin: { to: '/admin/kpi', label: 'Work metrics', icon: Gauge },
  kpiMine: { to: '/my/kpi', label: 'My metrics', icon: Gauge },
  kpiHr: { to: '/kpi/hr', label: 'HR metrics', icon: BarChart3 },
  teams: { to: '/teams', label: 'Teams', icon: UsersRound },
  groups: { to: '/groups', label: 'Groups', icon: Users },
  projects: { to: '/projects', label: 'Projects', icon: FolderKanban },
  scheduling: { to: '/meetings/scheduled', label: 'Scheduling', icon: CalendarClock, match: '/meetings' },
  assistant: { to: '/assistant', label: 'AI Assistant', icon: Sparkles },
  integrations: { to: '/admin/integrations', label: 'Integrations', icon: Blocks },
  users: { to: '/admin/users', label: 'Users', icon: UserCog },
  operations: { to: '/admin/operations', label: 'Operations', icon: ServerCog },
  settings: { to: '/actions/settings', label: 'Settings', icon: Settings2 },
};

const NAV = {
  admin: [
    ['Workspace', [I.overviewAdmin, I.actions, I.approvals]],
    ['Intelligence', [I.meetingsAdmin, I.digests, I.insights, I.activity, I.suggestions, I.duplicates, I.kpiAdmin]],
    ['Collaboration', [I.teams, I.groups, I.projects, I.scheduling]],
    ['AI', [I.assistant]],
    ['Administration', [I.integrations, I.users, I.operations, I.settings]],
  ],
  manager: [
    ['Workspace', [I.overview, I.myTasks, I.actions, I.approvals]],
    ['Intelligence', [I.digests, I.insights, I.activity, I.suggestions, I.duplicates, I.kpiMine]],
    ['Collaboration', [I.teams, I.groups, I.projects, I.scheduling]],
    ['AI', [I.assistant]],
  ],
  employee: [
    ['Workspace', [I.overview, I.myTasks, I.actions]],
    ['Intelligence', [I.insights, I.activity, I.duplicates, I.kpiMine]],
    ['Collaboration', [I.groups, I.projects, I.scheduling]],
    ['AI', [I.assistant]],
  ],
};
// People with the HR function (any role) also get the HR views.
const HR_NAV = [I.kpiHr, I.digests];

/** [[groupLabel, [item, …]], …] for this person. */
export function navFor(user) {
  const groups = (NAV[user.role] ?? NAV.employee).map(([g, items]) => [g, [...items]]);
  if (user.hrAccess || user.role === 'admin') {
    const all = new Set(groups.flatMap(([, items]) => items.map((i) => i.to)));
    const intel = groups.find(([g]) => g === 'Intelligence');
    for (const h of HR_NAV) if (!all.has(h.to)) intel[1].push(h);
  }
  return groups;
}

/** Whether a nav item is the current section for this path. */
export function isActive(item, pathname) {
  if (item.except?.some((p) => pathname.startsWith(p))) return false;
  const base = item.match ?? item.to;
  return item.end ? pathname === base : pathname === base || pathname.startsWith(`${base}/`);
}

// Pages that are not in the sidebar, for the breadcrumbs: [pattern, [label, to?] …].
const EXTRA = [
  [/^\/admin\/meetings\/new$/, [['Meetings', '/admin/meetings'], ['New meeting']]],
  [/^\/admin\/meetings\/[^/]+$/, [['Meetings', '/admin/meetings'], ['Meeting']]],
  [/^\/admin\/integrations\/teams-mock$/, [['Integrations', '/admin/integrations'], ['Microsoft Teams (mock)']]],
  [/^\/admin\/integrations\/[^/]+$/, [['Integrations', '/admin/integrations'], ['Connection']]],
  [/^\/integrations\/[^/]+\/setup$/, [['Integrations', '/admin/integrations'], ['Setup']]],
  [/^\/actions\/settings$/, [['Settings']]],
  [/^\/actions\/[^/]+$/, [['Action Center', '/actions'], ['Action item']]],
  [/^\/my\/tasks\/[^/]+$/, [['My tasks', '/my/tasks'], ['Task']]],
  [/^\/projects\/[^/]+$/, [['Projects', '/projects'], ['Project']]],
  [/^\/records\/[^/]+$/, [['Activity', '/activity'], ['Record']]],
  [/^\/assistant\/[^/]+$/, [['AI Assistant', '/assistant'], ['Conversation']]],
  [/^\/meetings\/schedule$/, [['Scheduling', '/meetings/scheduled'], ['Schedule a meeting']]],
  [/^\/meetings\/scheduled\/[^/]+$/, [['Scheduling', '/meetings/scheduled'], ['Meeting']]],
  [/^\/duplicates\/[^/]+$/, [['Duplicates', '/duplicates'], ['Finding']]],
  [/^\/digests\/[^/]+$/, [['Digests', '/digests'], ['Digest']]],
  [/^\/kpi\/teams\/[^/]+$/, [['Teams', '/teams'], ['Team metrics']]],
  [/^\/search$/, [['Search']]],
  [/^\/notifications$/, [['Notifications']]],
  [/^\/profile$/, [['Profile and preferences']]],
];

/** Breadcrumb trail for a path: [{ label, to? }], the last one being the current page. */
export function crumbsFor(user, pathname) {
  const groups = navFor(user);
  const sectionOf = (to) => groups.find(([, items]) => items.some((i) => i.to === to))?.[0];
  for (const [pattern, trail] of EXTRA) {
    if (!pattern.test(pathname)) continue;
    const section = trail[0][1] ? sectionOf(trail[0][1]) : null;
    return [...(section ? [{ label: section }] : []), ...trail.map(([label, to], n) => ({ label, to: n < trail.length - 1 ? to : undefined }))];
  }
  for (const [group, items] of groups) {
    const item = items.find((i) => isActive(i, pathname));
    if (item) return [{ label: group }, { label: item.label }];
  }
  return [];
}
