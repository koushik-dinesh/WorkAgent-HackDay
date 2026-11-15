// Meeting lifecycle shown the same way everywhere: scheduled → bot joining → recording →
// processing → review → approved → sent, or failed. One label, tone and icon per status.
import { Bot, CheckCircle2, CircleAlert, CircleDashed, ClipboardCheck, FileText, Loader, MailCheck, Radio, Sparkles } from 'lucide-react';
import { Badge } from './ui.jsx';

export const MEETING_STATUS = {
  draft: { label: 'Scheduled', tone: 'neutral', Icon: CircleDashed, hint: 'No transcript yet' },
  bot_requested: { label: 'Bot requested', tone: 'info', Icon: Bot, pulse: true },
  bot_joining: { label: 'Bot joining', tone: 'info', Icon: Bot, pulse: true },
  in_progress: { label: 'Recording', tone: 'danger', Icon: Radio, pulse: true },
  ended: { label: 'Processing', tone: 'info', Icon: Loader, pulse: true, hint: 'Waiting for the transcript' },
  transcript_ready: { label: 'Transcript ready', tone: 'info', Icon: FileText },
  extracting: { label: 'Extracting', tone: 'accent', Icon: Sparkles, pulse: true, hint: 'AI is finding action items' },
  review_pending: { label: 'Review pending', tone: 'warning', Icon: ClipboardCheck },
  approved: { label: 'Completed', tone: 'success', Icon: CheckCircle2, hint: 'Action items approved' },
  emails_sent: { label: 'Completed · emails sent', tone: 'success', Icon: MailCheck },
  failed: { label: 'Failed', tone: 'danger', Icon: CircleAlert },
};

export const meetingStatusLabel = (status) => MEETING_STATUS[status]?.label ?? String(status ?? '').replaceAll('_', ' ');

export function MeetingStatusBadge({ status }) {
  const s = MEETING_STATUS[status];
  if (!s) return <Badge tone="neutral">{meetingStatusLabel(status)}</Badge>;
  return (
    <Badge tone={s.tone} icon={s.Icon} pulse={s.pulse} title={s.hint}>
      {s.label}
    </Badge>
  );
}
