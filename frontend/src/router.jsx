import { Link, Navigate, createBrowserRouter } from 'react-router';
import { homePathFor, useAuth } from './auth/AuthContext.jsx';
import { ProtectedRoute } from './auth/ProtectedRoute.jsx';
import { AppShell } from './components/AppShell.jsx';
import { AcceptInvitationPage } from './pages/AcceptInvitation.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { ActivityFeedPage } from './pages/ActivityFeed.jsx';
import { InsightsPage } from './pages/Insights.jsx';
import { NotificationsPage } from './pages/Notifications.jsx';
import { OverviewPage } from './pages/Overview.jsx';
import { ProfilePage } from './pages/Profile.jsx';
import { IntegrationSetupPage } from './pages/IntegrationSetup.jsx';
import { RecordDetailPage } from './pages/RecordDetail.jsx';
import { SearchPage } from './pages/SearchPage.jsx';
import { SuggestionsPage } from './pages/Suggestions.jsx';
import { AdminDashboard } from './pages/admin/Dashboard.jsx';
import { IntegrationDetailPage } from './pages/admin/IntegrationDetail.jsx';
import { IntegrationsPage } from './pages/admin/Integrations.jsx';
import { TeamsMockViewPage } from './pages/admin/TeamsMockView.jsx';
import { MeetingDetailPage } from './pages/admin/MeetingDetail.jsx';
import { MeetingNewPage } from './pages/admin/MeetingNew.jsx';
import { MeetingsPage } from './pages/admin/Meetings.jsx';
import { OperationsPage } from './pages/admin/Operations.jsx';
import { UsersPage } from './pages/admin/Users.jsx';
import { MyTasks } from './pages/employee/MyTasks.jsx';
import { TaskDetail } from './pages/employee/TaskDetail.jsx';
import { ProjectDetailPage } from './pages/projects/ProjectDetail.jsx';
import { ProjectsPage } from './pages/projects/Projects.jsx';
import { TeamsPage } from './pages/teams/Teams.jsx';
import { AssistantPage } from './pages/assistant/Assistant.jsx';
import { DigestDetailPage, DigestsPage } from './pages/digests/Digests.jsx';
import { DuplicateDetailPage, DuplicatesPage } from './pages/duplicates/Duplicates.jsx';
import { GroupsPage } from './pages/groups/Groups.jsx';
import { HrKpiPage, KpiAdminPage, MyKpiPage, TeamKpiPage } from './pages/kpi/Kpi.jsx';
import { ScheduleMeetingPage } from './pages/scheduling/ScheduleMeeting.jsx';
import { ScheduledMeetingDetailPage, ScheduledMeetingsPage } from './pages/scheduling/ScheduledMeetings.jsx';
import { ActionCenterPage } from './pages/actions/ActionCenter.jsx';
import { ActionDetailPage } from './pages/actions/ActionDetail.jsx';
import { ActionSettingsPage } from './pages/actions/ActionSettings.jsx';
import { ApprovalsPage } from './pages/actions/Approvals.jsx';

function HomeRedirect() {
  const { user } = useAuth();
  return <Navigate to={homePathFor(user)} replace />;
}

function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-2 px-4 text-center">
      <p className="text-xs font-medium uppercase tracking-wider text-slate-400">404</p>
      <p className="text-lg font-semibold text-slate-900">Page not found.</p>
      <p className="text-sm text-slate-500">The page may have moved, or you may not have access to it.</p>
      <Link to="/" className="mt-3 text-sm font-medium text-accent-700 underline-offset-2 hover:underline">
        Go home
      </Link>
    </div>
  );
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  // Public: the invitation link from the email (token in the URL fragment).
  { path: '/accept-invitation', element: <AcceptInvitationPage /> },
  {
    element: <ProtectedRoute />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <HomeRedirect /> },
          {
            element: <ProtectedRoute roles={['admin']} />,
            children: [
              { path: '/admin', element: <AdminDashboard /> },
              { path: '/admin/meetings', element: <MeetingsPage /> },
              { path: '/admin/meetings/new', element: <MeetingNewPage /> },
              { path: '/admin/meetings/:id', element: <MeetingDetailPage /> },
              { path: '/admin/users', element: <UsersPage /> },
              { path: '/admin/integrations', element: <IntegrationsPage /> },
              { path: '/admin/integrations/teams-mock', element: <TeamsMockViewPage /> },
              { path: '/admin/integrations/:id', element: <IntegrationDetailPage /> },
              { path: '/admin/operations', element: <OperationsPage /> },
              { path: '/admin/kpi', element: <KpiAdminPage /> },
              { path: '/actions/settings', element: <ActionSettingsPage /> },
              // Where a provider sends the admin back after authorizing (e.g. GitHub's Setup URL).
              { path: '/integrations/:provider/setup', element: <IntegrationSetupPage /> },
            ],
          },
          {
            element: <ProtectedRoute roles={['employee', 'manager']} />,
            children: [
              { path: '/my/tasks', element: <MyTasks /> },
              { path: '/my/tasks/:id', element: <TaskDetail /> },
            ],
          },
          // Overview for every role: "what needs my attention"; each section reads an endpoint the API scopes.
          { path: '/overview', element: <OverviewPage /> },
          // Every role; the API decides which projects and teams each person can see or change.
          { path: '/projects', element: <ProjectsPage /> },
          { path: '/projects/:id', element: <ProjectDetailPage /> },
          { path: '/teams', element: <TeamsPage /> },
          // Phase 4: unified activity feed, synced record pages and search (server enforces visibility).
          { path: '/activity', element: <ActivityFeedPage /> },
          { path: '/records/:id', element: <RecordDetailPage /> },
          { path: '/search', element: <SearchPage /> },
          // Phase 7: insights for what each person may see (the API scopes them by role).
          { path: '/insights', element: <InsightsPage /> },
          // Phase 10: the signed-in person's own notifications, profile and preferences.
          { path: '/notifications', element: <NotificationsPage /> },
          { path: '/profile', element: <ProfilePage /> },
          // Features 2-6 (docs/FEATURES.md): every role; the API enforces who may see and do what.
          { path: '/assistant', element: <AssistantPage /> },
          { path: '/assistant/:id', element: <AssistantPage /> },
          { path: '/meetings/schedule', element: <ScheduleMeetingPage /> },
          { path: '/meetings/scheduled', element: <ScheduledMeetingsPage /> },
          { path: '/meetings/scheduled/:id', element: <ScheduledMeetingDetailPage /> },
          { path: '/groups', element: <GroupsPage /> },
          { path: '/duplicates', element: <DuplicatesPage /> },
          { path: '/duplicates/:id', element: <DuplicateDetailPage /> },
          { path: '/my/kpi', element: <MyKpiPage /> },
          { path: '/kpi/teams/:id', element: <TeamKpiPage /> },
          { path: '/kpi/hr', element: <HrKpiPage /> },
          { path: '/digests', element: <DigestsPage /> },
          { path: '/digests/:id', element: <DigestDetailPage /> },
          // Action Center and Approvals (docs/ACTION_INTELLIGENCE.md): every role; the API scopes items and plans.
          { path: '/actions', element: <ActionCenterPage /> },
          { path: '/actions/:id', element: <ActionDetailPage /> },
          { path: '/approvals', element: <ApprovalsPage /> },
          // Phase 5: relationship suggestions to review (the API returns only what the person may decide).
          {
            element: <ProtectedRoute roles={['admin', 'manager']} />,
            children: [{ path: '/suggestions', element: <SuggestionsPage /> }],
          },
        ],
      },
    ],
  },
  { path: '*', element: <NotFound /> },
]);
