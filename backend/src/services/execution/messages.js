// Text of the messages the execution engine sends (e-mail, Teams, Jira/GitHub comments).
// Plain, factual, and always naming the person who requested the action (an assignment is a social
// act, not an AI action). Every message links back to WorkAgent, where the evidence is.
import { config } from '../../config/index.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const appUrl = (path) => `${config.email.appPublicUrl ?? ''}${path}`;
const due = (i) => (i.dueDate ? `due ${i.dueDate}` : i.dueDateRaw ? `deadline “${i.dueDateRaw}” (not confirmed)` : 'no due date');
const origin = (i) => (i.meeting?.title ? `from the meeting “${i.meeting.title}”` : i.sourceLabel ? `from ${i.sourceLabel}` : '');

export const TEMPLATES = ['assignment', 'reminder', 'overdue_escalation', 'blocker_escalation', 'meeting_summary', 'custom'];

/**
 * @param template one of TEMPLATES
 * @param ctx { recipient: { fullName }, requester: { fullName }, items: [...], meeting?, note? }
 * @returns { subject, text, html }
 */
export function renderEmail(template, { recipient, requester, items, meeting = null, note = null, subject: customSubject = null }) {
  const first = recipient.fullName.split(' ')[0];
  const list = items.map((i) => `- ${i.title} (${due(i)}${i.priority === 'high' ? ', high priority' : ''}) ${origin(i)}\n  ${appUrl(`/actions/${i.id}`)}`).join('\n');
  const htmlList = `<ul>${items.map((i) => `<li><strong>${esc(i.title)}</strong> — ${esc(due(i))}${i.priority === 'high' ? ', high priority' : ''} ${esc(origin(i))} · <a href="${esc(appUrl(`/actions/${i.id}`))}">open in WorkAgent</a></li>`).join('')}</ul>`;
  const n = items.length;
  const plural = n === 1 ? 'action item' : 'action items';
  const subjects = {
    assignment: `${requester.fullName} assigned you ${n} ${plural}`,
    reminder: `Reminder: ${n} ${plural} due soon`,
    overdue_escalation: `${n} overdue ${plural} in your area`,
    blocker_escalation: `Blocked work needs your help (${n})`,
    meeting_summary: `Summary and action items: ${meeting?.title ?? 'meeting'}`,
    custom: customSubject ?? `Update from ${requester.fullName}`,
  };
  const intros = {
    assignment: `${requester.fullName} asked WorkAgent to send you the ${plural} you own:`,
    reminder: `These ${plural} you own are due soon:`,
    overdue_escalation: `These ${plural} in projects or teams you manage are past their due date:`,
    blocker_escalation: `These ${plural} are blocked and have not moved; you may be able to clear them:`,
    meeting_summary: `Action items agreed in “${meeting?.title ?? 'the meeting'}”${meeting?.scheduledAt ? ` (${String(meeting.scheduledAt).slice(0, 10)})` : ''}:`,
    custom: note ?? '',
  };
  const subject = subjects[template].slice(0, 250);
  const extra = note && template !== 'custom' ? `\n\n${note}` : '';
  const text = `Hi ${first},\n\n${intros[template]}\n\n${list}${extra}\n\nSent by WorkAgent on behalf of ${requester.fullName}. Open WorkAgent to see the evidence behind each item.`;
  const html = `<p>Hi ${esc(first)},</p><p>${esc(intros[template])}</p>${htmlList}${extra ? `<p>${esc(note)}</p>` : ''}<p style="color:#555">Sent by WorkAgent on behalf of ${esc(requester.fullName)}. Open WorkAgent to see the evidence behind each item.</p>`;
  return { subject, text, html };
}

/** Teams channel message (HTML). */
export function renderTeams(template, { requester, items, note = null, meeting = null }) {
  const head = {
    assignment: `Action items assigned by ${requester.fullName}`,
    meeting_summary: `Action items from “${meeting?.title ?? 'the meeting'}”`,
    blocker_escalation: 'Blocked work needs attention',
    reminder: 'Action items due soon',
    overdue_escalation: 'Overdue action items',
    custom: note ? 'Update' : 'Update',
  }[template] ?? 'Update';
  const rows = items.map((i) => `<li><b>${esc(i.title)}</b> — ${esc(i.assignee?.fullName ?? 'unassigned')}, ${esc(due(i))} · <a href="${esc(appUrl(`/actions/${i.id}`))}">WorkAgent</a></li>`).join('');
  return `<p><b>${esc(head)}</b></p>${note ? `<p>${esc(note)}</p>` : ''}<ul>${rows}</ul><p><i>Posted by WorkAgent on behalf of ${esc(requester.fullName)}.</i></p>`;
}

/** Description of an issue created from an action item: the item, its evidence, its WorkAgent id. */
export function issueBody(item, evidence, requester) {
  const lines = [
    item.description ?? '',
    '',
    `WorkAgent action #${item.id}${item.category ? ` (${item.category.replaceAll('_', ' ')})` : ''}, ${origin(item)}.`,
    ...(evidence.length ? ['Evidence:', ...evidence.slice(0, 5).map((e) => `> ${String(e.excerpt).slice(0, 300)}${e.speaker ? ` — ${e.speaker}` : ''}`)] : []),
    `Requested by ${requester.fullName} through WorkAgent: ${appUrl(`/actions/${item.id}`)}`,
  ];
  return lines.join('\n').trim();
}

export function commentBody(item, text, requester) {
  return `${text}\n\n— ${requester.fullName} via WorkAgent (action #${item.id}: ${appUrl(`/actions/${item.id}`)})`;
}
