// meeting.invite_send { meetingId }       creates the calendar event / in-app invitations after the
//                                         organiser confirmed (services/scheduling)
// meeting.attendees_refresh { meetingId } re-resolves a dynamic recurring meeting's groups
// directory.sync { connectionId }         Entra ID / Google Workspace users, departments and groups
import { syncDirectory } from '../../services/groups/directorySync.js';
import { markFailed, refreshAttendees, sendInvitations } from '../../services/scheduling/index.js';

export const meetingInviteSend = {
  async run(job) {
    await sendInvitations(job.payload.meetingId);
  },
  async onFailure(job, err, { final }) {
    if (final) await markFailed(job.payload.meetingId, err?.publicMessage ?? 'The calendar was unavailable; try again later');
  },
};

export const meetingAttendeesRefresh = {
  async run(job) {
    await refreshAttendees(job.payload.meetingId);
  },
};

export const directorySync = {
  async run(job) {
    await syncDirectory(job.payload.connectionId, { actorId: job.payload.actorId ?? null });
  },
};
