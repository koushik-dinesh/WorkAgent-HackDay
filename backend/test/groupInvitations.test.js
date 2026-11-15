// Feature: department and group-based meeting invitations. Groups (department, role, project,
// custom with nesting and cycle refusal), permissions, the combined picker, preview -> confirm ->
// send through WorkAgent and through Outlook (fake Graph: event creation, free/busy, cancel),
// changed-membership and large-group confirmations, dynamic recurring refresh, directory sync
// (fake Entra). MOCKED: no real Microsoft or Google endpoint is called.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { pool } from '../src/db/pool.js';
import { configureMicrosoft, resetMicrosoftSettings } from '../src/services/integrations/providers/microsoft/graph.js';
import { syncDirectory } from '../src/services/groups/directorySync.js';
import { refreshAttendees, sendInvitations } from '../src/services/scheduling/index.js';
import { CLIENT_ID, CLIENT_SECRET, TENANT, startFakeMicrosoft } from './integrations/fakeMicrosoft.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const ids = {};
const cookies = {};
let fake;
const as = (who) => ({
  get: (url) => request(app).get(url).set('Cookie', cookies[who]),
  post: (url, body) => request(app).post(url).set('Cookie', cookies[who]).send(body ?? {}),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookies[who]).send(body),
  delete: (url) => request(app).delete(url).set('Cookie', cookies[who]),
});
const future = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();
const one = async (sql, params) => (await pool.query(sql, params))[0][0];

describe('group-based meeting invitations', () => {
  before(async () => {
    await resetDatabase();
    fake = await startFakeMicrosoft();
    configureMicrosoft({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tenantId: TENANT, loginUrl: fake.url, graphUrl: fake.url, appPublicUrl: 'http://localhost:5173' });
    config.features.outlookCalendarWrite = true;
    config.features.msDirectorySync = true;
    ids.admin = await createUser({ email: 'admin@g.test', role: 'admin', fullName: 'Ada Admin' });
    ids.mgr = await createUser({ email: 'mgr@g.test', role: 'manager', fullName: 'Max Manager' });
    ids.emp = await createUser({ email: 'emp@g.test', role: 'employee', fullName: 'Eve Employee' });
    ids.priya = await createUser({ email: 'priya@g.test', role: 'employee', fullName: 'Priya Shah' });
    ids.raj = await createUser({ email: 'raj@g.test', role: 'employee', fullName: 'Raj Kumar' });
    ids.gone = await createUser({ email: 'gone@g.test', role: 'employee', fullName: 'Gone Person', isActive: false });
    for (const k of ['admin', 'mgr', 'emp']) cookies[k] = await loginCookie(app, `${k}@g.test`);
  });
  after(async () => {
    config.features.outlookCalendarWrite = false;
    config.features.msDirectorySync = false;
    resetMicrosoftSettings();
    await fake.close();
    await closeDatabase();
  });

  it('admins manage departments; a department group resolves from people’s department', async () => {
    assert.equal((await as('emp').post('/api/v1/departments', { name: 'Payments' })).status, 403);
    const d = await as('admin').post('/api/v1/departments', { name: 'Payments' });
    assert.equal(d.status, 201);
    ids.dept = d.body.department.id;
    for (const u of [ids.priya, ids.raj, ids.emp, ids.gone]) assert.equal((await as('admin').patch(`/api/v1/users/${u}`, { departmentId: ids.dept })).status, 200);
    await as('admin').patch(`/api/v1/users/${ids.priya}`, { jobTitle: 'QA Lead' });
    const list = await as('admin').get('/api/v1/groups?type=department');
    const g = list.body.groups.find((x) => x.departmentId === ids.dept);
    ids.deptGroup = g.id;
    assert.equal(g.memberCount, 3, 'inactive people are never members');
    const detail = await as('admin').get(`/api/v1/groups/${g.id}`);
    assert.deepEqual(detail.body.members.map((m) => m.fullName).sort(), ['Eve Employee', 'Priya Shah', 'Raj Kumar']);
    assert.match(detail.body.membershipSource, /department/);
  });

  it('role groups (admins only) follow job titles; employees cannot see them', async () => {
    assert.equal((await as('mgr').post('/api/v1/groups', { name: 'QA leads', type: 'role', roleValue: 'QA Lead' })).status, 403);
    const r = await as('admin').post('/api/v1/groups', { name: 'QA leads', type: 'role', roleValue: 'qa lead' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ids.roleGroup = r.body.group.id;
    assert.deepEqual(r.body.members.map((m) => m.id), [ids.priya]);
    assert.equal((await as('emp').get(`/api/v1/groups/${ids.roleGroup}`)).status, 404);
    const managers = await as('admin').post('/api/v1/groups', { name: 'All managers', type: 'role', roleValue: 'app:manager' });
    assert.deepEqual(managers.body.members.map((m) => m.id), [ids.mgr]);
  });

  it('project groups are created for projects and resolve owner + members', async () => {
    const [p] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Payments revamp', ?, 'active')", [ids.mgr]);
    ids.project = p.insertId;
    await pool.execute('INSERT INTO project_members (project_id, user_id) VALUES (?, ?), (?, ?)', [ids.project, ids.raj, ids.project, ids.emp]);
    const g = (await as('emp').get('/api/v1/groups?type=project')).body.groups.find((x) => x.projectId === ids.project);
    assert.ok(g, 'the employee is on the project, so sees its group');
    ids.projectGroup = g.id;
    assert.equal(g.memberCount, 3);
  });

  it('custom groups: owner edits, nesting expands, cycles are refused, others cannot edit', async () => {
    const a = await as('emp').post('/api/v1/groups', { name: 'Release captains', memberIds: [ids.priya] });
    assert.equal(a.status, 201);
    ids.custom = a.body.group.id;
    const b = await as('emp').post('/api/v1/groups', { name: 'Captains + project', childGroupIds: [ids.custom, ids.projectGroup] });
    ids.parent = b.body.group.id;
    assert.deepEqual(b.body.members.map((m) => m.fullName).sort(), ['Eve Employee', 'Max Manager', 'Priya Shah', 'Raj Kumar']);
    const priya = b.body.members.find((m) => m.id === ids.priya);
    assert.deepEqual(priya.via, [ids.parent]);
    const cycle = await as('emp').post(`/api/v1/groups/${ids.custom}/members`, { childGroupIds: [ids.parent] });
    assert.equal(cycle.status, 409);
    assert.equal(cycle.body.error.code, 'GROUP_CYCLE');
    assert.equal((await as('mgr').patch(`/api/v1/groups/${ids.custom}`, { name: 'x' })).status, 403);
    assert.equal((await as('emp').post(`/api/v1/groups/${ids.custom}/members`, { userIds: [ids.gone] })).status, 400, 'inactive people cannot be added');
    const removed = await as('emp').delete(`/api/v1/groups/${ids.custom}/members/${ids.priya}`);
    assert.equal(removed.body.group.memberCount, 0);
    await as('emp').post(`/api/v1/groups/${ids.custom}/members`, { userIds: [ids.priya] });
  });

  it('the combined picker returns people and groups with their type', async () => {
    const res = await as('emp').get('/api/v1/scheduling/attendees/search?q=pa');
    const kinds = new Set(res.body.results.map((r) => r.kind));
    assert.ok(kinds.has('department') && kinds.has('project'));
    assert.ok(!res.body.results.some((r) => r.kind === 'role'), 'employees do not see role groups');
    const people = await as('emp').get('/api/v1/scheduling/attendees/search?q=priya');
    assert.deepEqual(people.body.results.filter((r) => r.kind === 'person').map((r) => r.id), [ids.priya]);
  });

  const meeting = (extra = {}) => ({ title: 'Design review', startAt: future(48), durationMinutes: 60, timeZone: 'Asia/Kolkata', provider: 'workagent', attendees: { userIds: [ids.priya], groupIds: [ids.deptGroup] }, excludedUserIds: [], ...extra });

  it('preview resolves at send time, de-duplicates, applies exclusions and shows why people are invited', async () => {
    const res = await as('emp').post('/api/v1/scheduling/meetings/preview', meeting({ excludedUserIds: [ids.raj] }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 1, 'organiser (Eve) is not an attendee; Raj excluded; Priya once');
    assert.deepEqual(res.body.invitees[0].via.map((v) => v.type).sort(), ['group', 'individual']);
    assert.deepEqual(res.body.excluded.map((p) => p.id), [ids.raj]);
    assert.equal(res.body.requiresLargeConfirmation, false);
    assert.match(res.body.warnings.join(' '), /inside WorkAgent only/);
    const denied = await as('emp').post('/api/v1/scheduling/meetings/preview', meeting({ attendees: { userIds: [], groupIds: [ids.roleGroup] } }));
    assert.equal(denied.status, 400, 'role groups are not invitable by employees (reported as unknown)');
  });

  it('sending needs confirmation and the confirmed list; a changed membership is refused', async () => {
    const preview = (await as('emp').post('/api/v1/scheduling/meetings/preview', meeting())).body;
    assert.equal((await as('emp').post('/api/v1/scheduling/meetings', { ...meeting(), recipientsHash: preview.recipientsHash })).status, 400, 'confirm is required');
    await as('admin').patch(`/api/v1/users/${ids.mgr}`, { departmentId: ids.dept }); // membership changes after the preview
    const changed = await as('emp').post('/api/v1/scheduling/meetings', { ...meeting(), confirm: true, recipientsHash: preview.recipientsHash });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, 'RECIPIENTS_CHANGED');
    const fresh = changed.body.error.details.preview.recipientsHash;
    const ok = await as('emp').post('/api/v1/scheduling/meetings', { ...meeting(), confirm: true, recipientsHash: fresh });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    ids.m1 = ok.body.meeting.id;
    assert.equal(ok.body.schedule.status, 'sending');
    assert.equal(await sendInvitations(ids.m1), 'sent');
    const notif = await one("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'meeting_invited' AND entity_id = ?", [ids.m1]);
    assert.equal(Number(notif.n), 3);
    const priyaView = await request(app).get(`/api/v1/scheduling/meetings/${ids.m1}`).set('Cookie', await loginCookie(app, 'priya@g.test'));
    assert.equal(priyaView.status, 200);
    assert.equal(priyaView.body.invitees[0].via, undefined, 'only the organiser sees why people were invited');
    const audit = await one("SELECT after_json FROM audit_logs WHERE action = 'meeting.scheduled' AND entity_id = ?", [ids.m1]);
    assert.equal((typeof audit.after_json === 'string' ? JSON.parse(audit.after_json) : audit.after_json).recipients, 3);
  });

  it('lists above the threshold need a second confirmation', async () => {
    config.features.groupLargeThreshold = 2;
    try {
      const preview = (await as('emp').post('/api/v1/scheduling/meetings/preview', meeting())).body;
      assert.equal(preview.requiresLargeConfirmation, true);
      const res = await as('emp').post('/api/v1/scheduling/meetings', { ...meeting(), confirm: true, recipientsHash: preview.recipientsHash });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'LARGE_CONFIRMATION_REQUIRED');
      const ok = await as('emp').post('/api/v1/scheduling/meetings', { ...meeting(), confirm: true, recipientsHash: preview.recipientsHash, largeConfirmed: true });
      assert.equal(ok.status, 201);
      assert.equal(ok.body.schedule.largeConfirmed, true);
    } finally {
      config.features.groupLargeThreshold = 50;
    }
  });

  it('sends through the organiser’s own Outlook (Teams link), checks free/busy, and cancels', async () => {
    // The admin connects Outlook with calendar write; only the admin may send from it.
    const start = await as('admin').post('/api/v1/integrations/outlook/connect');
    assert.match(decodeURIComponent(start.body.redirectUrl), /Calendars\.ReadWrite/);
    const state = new URL(start.body.redirectUrl).searchParams.get('state');
    const cb = await as('admin').post('/api/v1/integrations/outlook/callback', { state, params: { code: fake.grantCode('offline_access User.Read Mail.Read Calendars.Read Calendars.ReadWrite User.Read.All GroupMember.Read.All') } });
    assert.equal(cb.status, 201, JSON.stringify(cb.body));
    ids.outlook = cb.body.connection.id;
    const cals = (await as('admin').get('/api/v1/scheduling/calendars')).body.calendars;
    assert.ok(cals.find((c) => c.connectionId === ids.outlook).canWrite);
    assert.equal((await as('emp').get('/api/v1/scheduling/calendars')).body.calendars.length, 1, 'others cannot send from the admin’s calendar');
    const m = meeting({ provider: 'outlook', connectionId: ids.outlook, attendees: { userIds: [ids.priya, ids.raj], groupIds: [] } });
    const startAt = new Date(m.startAt);
    fake.state.busy['priya@g.test'] = [{ start: startAt.toISOString().slice(0, 19), end: new Date(startAt.getTime() + 30 * 60_000).toISOString().slice(0, 19) }];
    const preview = (await as('admin').post('/api/v1/scheduling/meetings/preview', m)).body;
    assert.equal(preview.availability.checked, true);
    assert.deepEqual(preview.availability.conflicts.map((c) => c.userId), [ids.priya]);
    assert.ok(preview.availability.suggestions.length >= 1);
    const empTry = await as('emp').post('/api/v1/scheduling/meetings/preview', m);
    assert.equal(empTry.status, 400, 'cannot use someone else’s calendar connection');
    const ok = await as('admin').post('/api/v1/scheduling/meetings', { ...m, confirm: true, recipientsHash: preview.recipientsHash });
    assert.equal(ok.status, 201);
    assert.equal(await sendInvitations(ok.body.meeting.id), 'sent');
    assert.equal(await sendInvitations(ok.body.meeting.id), 'skipped', 'a retried job does nothing');
    const ev = fake.state.createdEvents.at(-1);
    assert.deepEqual(ev.body.attendees.map((a) => a.emailAddress.address).sort(), ['priya@g.test', 'raj@g.test']);
    assert.equal(ev.body.isOnlineMeeting, true);
    const detail = (await as('admin').get(`/api/v1/scheduling/meetings/${ok.body.meeting.id}`)).body;
    assert.match(detail.meeting.meetingUrl, /teams\.microsoft\.com/);
    assert.equal((await as('emp').post(`/api/v1/scheduling/meetings/${ok.body.meeting.id}/cancel`, {})).status, 404, 'not visible to non-invitees');
    const cancel = await as('admin').post(`/api/v1/scheduling/meetings/${ok.body.meeting.id}/cancel`, { reason: 'Moved' });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.providerCancelled, true);
    assert.equal(ev.cancelled, true);
  });

  it('dynamic recurring meetings re-resolve their groups; pinned ones do not', async () => {
    const base = meeting({ provider: 'outlook', connectionId: ids.outlook, attendees: { userIds: [], groupIds: [ids.custom] }, recurrence: { frequency: 'weekly', interval: 1, count: 4 } });
    const results = {};
    for (const mode of ['dynamic', 'pinned']) {
      const p = (await as('admin').post('/api/v1/scheduling/meetings/preview', { ...base, membershipMode: mode })).body;
      const r = await as('admin').post('/api/v1/scheduling/meetings', { ...base, membershipMode: mode, confirm: true, recipientsHash: p.recipientsHash });
      await sendInvitations(r.body.meeting.id);
      results[mode] = r.body.meeting.id;
    }
    assert.ok(fake.state.createdEvents.at(-1).body.recurrence.range.numberOfOccurrences === 4);
    await as('emp').post(`/api/v1/groups/${ids.custom}/members`, { userIds: [ids.raj] });
    await pool.execute('UPDATE meeting_schedules SET last_resolved_at = NULL');
    assert.equal(await refreshAttendees(results.dynamic), 'updated');
    assert.equal(await refreshAttendees(results.pinned), 'skipped');
    const dyn = await one('SELECT COUNT(*) AS n FROM meeting_invitees WHERE meeting_id = ? AND excluded = FALSE', [results.dynamic]);
    assert.equal(Number(dyn.n), 2);
  });

  it('directory sync (Entra) creates departments, matches people by e-mail, and adds read-only groups', async () => {
    fake.state.directory = {
      users: [
        { id: 'u1', mail: 'raj@g.test', department: 'Engineering', jobTitle: 'Developer', accountEnabled: true },
        { id: 'u2', mail: 'priya@g.test', department: 'Engineering', jobTitle: 'Engineer', accountEnabled: true },
        { id: 'u3', mail: 'stranger@other.test', department: 'Sales', accountEnabled: true },
        { id: 'u4', mail: 'dev@g.test', department: 'Engineering', jobTitle: 'Developer', accountEnabled: true },
      ],
      groups: [{ id: 'grp-1', displayName: 'Platform guild' }, { id: 'grp-2', displayName: 'Guild leads' }],
      members: { 'grp-1': [{ type: 'user', mail: 'raj@g.test' }, { type: 'group', id: 'grp-2' }, { type: 'user', mail: 'stranger@other.test' }], 'grp-2': [{ type: 'user', mail: 'priya@g.test' }] },
    };
    const status = (await as('admin').get('/api/v1/groups/directory/status')).body;
    assert.equal(status.connections.find((c) => c.connectionId === ids.outlook).canSync, true);
    ids.dev = await createUser({ email: 'dev@g.test', fullName: 'Dev Directory' });
    const result = await syncDirectory(ids.outlook, { actorId: ids.admin });
    assert.equal(result.ok, true, JSON.stringify(result));
    const dev = await one('SELECT d.name AS dept, u.job_title, u.directory_source FROM users u JOIN departments d ON d.id = u.department_id WHERE u.id = ?', [ids.dev]);
    assert.deepEqual([dev.dept, dev.job_title, dev.directory_source], ['Engineering', 'Developer', 'entra']);
    const raj = await one('SELECT d.name AS dept FROM users u JOIN departments d ON d.id = u.department_id WHERE u.id = ?', [ids.raj]);
    assert.equal(raj.dept, 'Payments', 'a department set by an admin is kept');
    const priya = await one('SELECT job_title FROM users WHERE id = ?', [ids.priya]);
    assert.equal(priya.job_title, 'QA Lead', 'attributes set by an admin are kept');
    const guild = (await as('admin').get('/api/v1/groups?q=Platform')).body.groups[0];
    assert.equal(guild.source, 'entra');
    assert.equal(guild.memberCount, 2, 'Raj + Priya through the nested group; the stranger is not a WorkAgent user');
    assert.equal((await as('admin').patch(`/api/v1/groups/${guild.id}`, { name: 'x' })).status, 409, 'directory groups are read-only');
  });
});
