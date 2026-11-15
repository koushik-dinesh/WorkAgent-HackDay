// Automated follow-up (services/actions/followups.js): reminders before deadlines, overdue
// escalation to the manager, commitments without progress, unresolved blockers; once per day;
// people's notification preferences; e-mail only under an admin policy, as audited plans.
// MOCKED: e-mail uses a fake provider; nothing leaves the test.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool } from '../src/db/pool.js';
import { email } from '../src/services/email/index.js';
import * as followups from '../src/services/actions/followups.js';
import { setPreferences } from '../src/services/notifications/inbox.js';
import { addDays, localDate } from '../src/utils/dates.js';
import { config } from '../src/config/index.js';
import { closeDatabase, createUser, resetDatabase } from './helpers.js';

const ids = {};
const originalEmail = { ...email };
const today = () => localDate(new Date(), config.features.orgTimeZone);
const notes = async (kind, userId) => (await pool.query('SELECT title FROM notifications WHERE kind = ? AND user_id = ? ORDER BY id', [kind, userId]))[0].map((r) => r.title);

async function item(title, { due = null, status = 'todo', approvedDaysAgo = 1, flags = [] } = {}) {
  const [r] = await pool.execute(
    "INSERT INTO action_items (meeting_id, project_id, source_type, title, assignee_user_id, assignee_match, review_status, task_status, due_date, approved_at, flags) VALUES (NULL, ?, 'teams_message', ?, ?, 'exact', 'approved', ?, ?, NOW() - INTERVAL ? DAY, ?)",
    [ids.P, title, ids.emp, status, due, approvedDaysAgo, JSON.stringify(flags)],
  );
  return r.insertId;
}

before(async () => {
  await resetDatabase();
  ids.admin = await createUser({ email: 'admin@f.test', role: 'admin', fullName: 'Ada Admin' });
  ids.mgr = await createUser({ email: 'mgr@f.test', role: 'manager', fullName: 'Max Manager' });
  ids.emp = await createUser({ email: 'emp@f.test', fullName: 'Eve Employee' });
  const [p] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Payments', ?, 'active')", [ids.mgr]);
  ids.P = p.insertId;
  ids.soon = await item('Ship the refund fix', { due: addDays(today(), 1) });
  ids.late = await item('Send the post-mortem', { due: addDays(today(), -3) });
  ids.stale = await item('Write the runbook', { approvedDaysAgo: 10 });
  ids.blocked = await item('Move payments to the new cluster', { status: 'blocked', approvedDaysAgo: 5 });
  await pool.execute("INSERT INTO audit_logs (action, entity_type, entity_id, created_at) VALUES ('task.status_changed', 'action_item', ?, NOW() - INTERVAL 4 DAY)", [ids.blocked]);
});
after(async () => {
  Object.assign(email, originalEmail);
  await closeDatabase();
});

describe('follow-up automation', () => {
  it('reminds owners, escalates overdue work and blockers to the manager, flags stalled commitments — once', async () => {
    const out = await followups.run();
    assert.ok(out.reminders >= 1 && out.overdueEscalations >= 1 && out.noProgress >= 1 && out.blockerEscalations >= 1, JSON.stringify(out));
    assert.ok((await notes('action_reminder', ids.emp)).some((t) => t.includes('Ship the refund fix')));
    assert.ok((await notes('action_reminder', ids.emp)).some((t) => t.startsWith('No progress') && t.includes('Write the runbook')));
    const mgr = await notes('action_escalation', ids.mgr);
    assert.ok(mgr.some((t) => t.includes('Send the post-mortem')));
    assert.ok(mgr.some((t) => t.startsWith('Still blocked') && t.includes('Move payments')));
    const again = await followups.run();
    assert.deepEqual([again.reminders, again.overdueEscalations, again.noProgress, again.blockerEscalations], [0, 0, 0, 0]);
  });

  it('respects personal notification preferences', async () => {
    await pool.query("DELETE FROM notifications WHERE kind = 'action_reminder'");
    await setPreferences(ids.emp, { notifications: { action_reminder: false } });
    await followups.run();
    assert.deepEqual(await notes('action_reminder', ids.emp), []);
    await setPreferences(ids.emp, { notifications: { action_reminder: true } });
  });

  it('sends e-mail only when an admin enabled it, as policy-approved plans in the execution engine', async () => {
    const sent = [];
    email.isConfigured = () => true;
    email.configurationProblem = () => null;
    email.from = () => 'noreply@f.test';
    email.getProvider = () => ({ name: 'fake', send: async (m) => (sent.push(m), { messageId: `m${sent.length}` }) });
    assert.equal((await followups.run()).emailPlans, 0, 'off by default');
    await followups.updateSettings({ id: ids.admin }, { channels: { email: true } });
    await pool.query("DELETE FROM notifications WHERE kind IN ('action_reminder','action_escalation')");
    const out = await followups.run();
    assert.ok(out.emailPlans >= 2, JSON.stringify(out));
    const plans = (await pool.query("SELECT status, origin, approval_basis FROM action_plans WHERE origin = 'followup'"))[0];
    assert.ok(plans.every((p) => p.approval_basis === 'policy' && p.status === 'scheduled'));
    const audit = (await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'action_plan.approved_by_policy'"))[0][0].n;
    assert.equal(Number(audit), plans.length);
  });
});
