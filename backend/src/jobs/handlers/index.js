import { actionItemExport } from './actionItemExport.js';
import { aiExtract } from './aiExtract.js';
import { correlationEvaluate } from './correlationEvaluate.js';
import { emailSend } from './emailSend.js';
import { integrationMaintenance } from './integrationMaintenance.js';
import { integrationSync } from './integrationSync.js';
import { integrationWebhook } from './integrationWebhook.js';
import { meetingTranscriptImport } from './meetingTranscriptImport.js';
import { notificationsScan } from './notificationsScan.js';
import { directorySync, meetingAttendeesRefresh, meetingInviteSend } from './scheduling.js';
import { decisionsExtract, duplicatesScan, duplicatesSweep } from './duplicates.js';
import { kpiCompute } from './kpi.js';
import { digestDeliver, digestGenerate } from './digest.js';
import { vexaPoll } from './vexaPoll.js';
import { vexaAutoScan } from './vexaAutoScan.js';
import { actionExecute, actionsSourceScan } from './actions.js';

// Job type -> handler. (Transcript fetching is part of 'vexa.poll'.)
export const handlers = {
  'ai.extract': aiExtract,
  'email.send': emailSend,
  'vexa.poll': vexaPoll,
  'vexa.auto_scan': vexaAutoScan,
  'integration.sync': integrationSync,
  'integration.webhook': integrationWebhook,
  'integration.maintenance': integrationMaintenance,
  'correlation.evaluate': correlationEvaluate,
  'notifications.scan': notificationsScan,
  'meeting.transcript_import': meetingTranscriptImport,
  'action_item.export': actionItemExport,
  // Features 2-6 (docs/FEATURES.md)
  'meeting.invite_send': meetingInviteSend,
  'meeting.attendees_refresh': meetingAttendeesRefresh,
  'directory.sync': directorySync,
  'duplicates.scan': duplicatesScan,
  'duplicates.sweep': duplicatesSweep,
  'meeting.decisions_extract': decisionsExtract,
  'kpi.compute': kpiCompute,
  'digest.generate': digestGenerate,
  'digest.deliver': digestDeliver,
  // Action intelligence and execution
  'action.execute': actionExecute,
  'actions.source_scan': actionsSourceScan,
};

/** The handlers this worker runs: all, or only those listed in WORKER_JOB_TYPES. */
export function handlersFor(types) {
  if (!types?.length) return handlers;
  const unknown = types.filter((t) => !handlers[t]);
  if (unknown.length) throw new Error(`WORKER_JOB_TYPES lists unknown job types: ${unknown.join(', ')}`);
  return Object.fromEntries(types.map((t) => [t, handlers[t]]));
}
