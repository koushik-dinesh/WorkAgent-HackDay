// Figma files, Microsoft Teams channel conversations, Outlook e-mail, and the action items that
// originate from them (source_type figma_comment / teams_message / outlook_email / jira_comment /
// github_comment). Days are offsets from the anchor; `at` is local office time.

// ---- Figma ----------------------------------------------------------------------------------------
export const FIGMA_FOLDERS = [
  { id: '880101', name: 'Atlas', project: 'atlas' },
  { id: '880102', name: 'Canvas', project: 'canvas' },
  { id: '880103', name: 'Nova', project: 'nova' },
  { id: '880104', name: 'Orion', project: 'orion' },
];

export const FIGMA_FILES = [
  {
    key: 'AtLsWs8kD2qPzE', folder: '880101', name: 'Atlas — Enterprise Workspace Design System', owner: 'laya', lastTouchedBy: 'divya', created: -85, modified: -16,
    versions: [
      { id: '4100231', day: -84, by: 'laya', label: 'Foundations', description: 'Type scale, spacing, workspace shell.' },
      { id: '4100957', day: -61, by: 'laya', label: 'Timeline v3 — delivery states', description: 'Queued, delivered, failed and retrying, with retry details for admins.' },
      { id: '4101544', day: -48, by: 'laya', label: 'Status colour rule: people vs system', description: 'Amber when a person must act, blue while the system is working.' },
      { id: '4102210', day: -16, by: 'divya', label: 'Failed-state copy from support', description: 'Updated failed and retrying copy.' },
    ],
    comments: [
      { id: '7700101', day: -54, at: '16:10', by: 'laya', text: 'The current activity panel takes too much horizontal space. Can we try a more compact layout?' },
      { id: '7700102', day: -54, at: '16:42', by: 'kavya', replyTo: '7700101', text: 'I agree. We should preserve the evidence preview but make it collapsible.' },
      { id: '7700103', day: -53, at: '09:20', by: 'anjana', replyTo: '7700101', text: 'The status indicators also need to be consistent with the approval workflow.' },
      { id: '7700104', day: -45, at: '17:05', by: 'divya', text: 'Compact variant added next to the current one on "Timeline v3". The evidence preview collapses to a single line with an expand control.', resolved: -45 },
      { id: '7700105', day: -38, at: '12:15', by: 'sneha', text: 'Retry tooltip is implemented (ATL-117). It matches this frame; fixed a 4px offset on the badge.', resolved: -38 },
    ],
  },
  {
    key: 'CnVsOv3rV1ew9T', folder: '880102', name: 'Canvas — Project Overview and Activity Timeline', owner: 'laya', lastTouchedBy: 'laya', created: -75, modified: -2,
    versions: [
      { id: '4200118', day: -64, by: 'divya', label: 'Overview v1', description: 'First layout against the status definitions.' },
      { id: '4200562', day: -59, by: 'divya', label: 'Overview v2 (design review)', description: 'Status with reasons, three columns, shared timeline.' },
      { id: '4201390', day: -33, by: 'divya', label: 'Usability round 1 fixes', description: 'Seven of ten understood status; changes from the sessions.' },
      { id: '4201811', day: -16, by: 'laya', label: 'Reasons in the badge row', description: 'Reasons visible without scrolling; softer "at risk" wording.' },
      { id: '4202067', day: -2, by: 'laya', label: 'Design QA notes', description: 'Spacing corrections for the build.' },
    ],
    comments: [
      { id: '7710101', day: -57, at: '10:05', by: 'kavya', text: 'Reasons must stay visible without scrolling — a red badge without an explanation is the main pilot complaint.' },
      { id: '7710102', day: -57, at: '11:30', by: 'anjana', text: 'Amber text on the light amber badge measures 3.1:1 — fails AA. Please check every badge combination.' },
      { id: '7710103', day: -56, at: '14:00', by: 'meera', text: 'Tablet: three columns will not fit at 1024px. Should they stack?' },
      { id: '7710104', day: -55, at: '09:45', by: 'divya', replyTo: '7710103', text: 'Stacked variant is on the page "Overview v2 — tablet". Navigation collapse still to be designed.', resolved: -55 },
      { id: '7710105', day: -15, at: '15:20', by: 'kavya', text: 'New wording for "at risk" added to the copy frame — rules unchanged.' },
      { id: '7710106', day: -2, at: '12:40', by: 'laya', text: 'Design QA: card padding should be 16px (build has 12px) and the gap under the badge row 16px (build has 8px).' },
    ],
  },
  {
    key: 'NvAiNt3lL1g4cX', folder: '880103', name: 'Nova — Intelligence Dashboard Exploration', owner: 'divya', lastTouchedBy: 'divya', created: -40, modified: -15,
    versions: [
      { id: '4300402', day: -26, by: 'divya', label: 'Directions A, B, C', description: 'Ranked list, portfolio map, list with a "why" panel.' },
      { id: '4300977', day: -15, by: 'divya', label: 'Direction C — why panel', description: 'Reason sentences, evidence links and 90-day trend.' },
    ],
    comments: [
      { id: '7720101', day: -23, at: '17:30', by: 'siddharth', text: 'Account managers liked B in the first minute and C after five minutes of real use.' },
      { id: '7720102', day: -22, at: '10:10', by: 'kavya', text: 'Can the trend line show the labelled outcome markers, so we can sanity-check the model visually during evaluation?' },
      { id: '7720103', day: -21, at: '11:45', by: 'arjun', replyTo: '7720102', text: 'Yes — I can add the label and its date to the trend points in the contract.' },
    ],
  },
  {
    key: 'OrNaPpR0v4lX7Q', folder: '880104', name: 'Orion — Approval and Execution Experience', owner: 'laya', lastTouchedBy: 'divya', created: -70, modified: -30,
    versions: [
      { id: '4400311', day: -55, by: 'divya', label: 'Approval inbox v1', description: 'Rendered previews per execution, large-plan table.' },
      { id: '4400789', day: -45, by: 'divya', label: 'Cancellation countdown', description: 'Undo toast and persistent countdown on the plan.' },
      { id: '4401204', day: -30, by: 'divya', label: 'Inbox — rendered previews', description: 'GA scope; diff deferred.' },
    ],
    comments: [
      { id: '7730101', day: -50, at: '15:00', by: 'kavya', text: 'Buttons should say what will happen — "Create 3 Jira issues", not "Approve".' },
      { id: '7730102', day: -47, at: '11:15', by: 'anjana', text: 'The "executing" badge uses amber here; by the shared rule it should be blue (system working). Amber is for awaiting approval.' },
      { id: '7730103', day: -45, at: '16:30', by: 'rohan', text: 'The countdown needs server time — I will expose cancelUntil in the plan response.', resolved: -40 },
    ],
  },
];

// ---- Microsoft Teams ------------------------------------------------------------------------------
export const TEAMS_CHANNELS = [
  { key: 'engineering', team: 'Engineering', channel: 'engineering', project: null },
  { key: 'atlas-project', team: 'Engineering', channel: 'atlas-project', project: 'atlas' },
  { key: 'orion-automation', team: 'Engineering', channel: 'orion-automation', project: 'orion' },
  { key: 'release-coordination', team: 'Engineering', channel: 'release-coordination', project: 'atlas' },
  { key: 'product-design', team: 'Product & Design', channel: 'product-design', project: 'canvas' },
  { key: 'quality-assurance', team: 'Quality', channel: 'quality-assurance', project: 'sentinel' },
  { key: 'leadership', team: 'Leadership', channel: 'leadership', project: null },
];

// Posts with replies. id is unique per channel.
export const TEAMS_POSTS = [
  { channel: 'engineering', id: 'p-e1', day: -63, at: '18:05', by: 'keerthan', subject: 'Platform on-call rotation', text: 'Reminder: the platform on-call rotation starts on Monday. The schedule is in the runbook. Swap with each other freely, just update the calendar.', replies: [
    { id: 'r-e1-1', day: -63, at: '18:20', by: 'thiru', text: 'I will take the first week.' },
    { id: 'r-e1-2', day: -63, at: '18:31', by: 'aaryan', text: 'Second week works for me.' },
  ] },
  { channel: 'engineering', id: 'p-e2', day: -29, at: '10:15', by: 'keerthan', subject: 'Review expectations from Monday', text: 'From Monday: first review within one working day, and a reviewer rotation per repository (table pinned in this channel). If you cannot make it, hand it on — please do not sit on it.', replies: [
    { id: 'r-e2-1', day: -29, at: '10:22', by: 'rohan', text: 'Rotation table bookmarked.' },
    { id: 'r-e2-2', day: -29, at: '10:40', by: 'sneha', text: 'Can canvas-frontend have Meera as a fallback reviewer?' },
    { id: 'r-e2-3', day: -29, at: '10:44', by: 'keerthan', text: 'Yes, added.' },
  ] },
  { channel: 'engineering', id: 'p-e3', day: -17, at: '15:50', by: 'aaryan', subject: 'Mail relay timeout and slow-provider queue', text: 'Post-incident follow-up is live: the mail relay timeout is now 10 seconds and slow providers have their own queue. If you see e-mail delays in staging, that is the slow-provider queue doing its job.', replies: [
    { id: 'r-e3-1', day: -17, at: '16:05', by: 'thiru', text: 'The Pulse dashboard now shows lag per provider queue.' },
  ] },
  { channel: 'atlas-project', id: 'p-a1', day: -66, at: '17:40', by: 'aaryan', subject: 'ATL-104 merged', text: 'ATL-104 is merged — idempotent dispatch is live in staging (PR #47). Duplicate deliveries on restart should now be impossible; the restart suite will prove it.', replies: [
    { id: 'r-a1-1', day: -66, at: '17:52', by: 'anjana', text: 'The restart suite (PR #49) goes in tomorrow and will run on every build.' },
    { id: 'r-a1-2', day: -66, at: '18:10', by: 'kavya', text: 'Great — I will mention it in the next pilot update.' },
  ] },
  { channel: 'atlas-project', id: 'p-a2', day: -36, at: '11:25', by: 'thiru', subject: 'Fan-out test results', text: 'Fan-out test without per-tenant limits: 50k recipients delivered in 11 minutes, but other tenants waited up to 9 minutes. Details in ATL-109.', replies: [
    { id: 'r-a2-1', day: -36, at: '11:40', by: 'keerthan', text: 'This is the strongest argument for ATL-109 we will get. Thanks.' },
  ] },
  { channel: 'atlas-project', id: 'p-a3', day: -5, at: '12:05', by: 'thiru', subject: 'Rate limiting rebased', text: 'The rate limiting branch is rebased on the middleware reorder. Can someone from Application Development check that the SSO login flow still works with the new middleware order?', replies: [
    { id: 'r-a3-1', day: -4, at: '10:30', by: 'rohan', text: 'Checked against the Entra ID test tenant and Okta: login, logout and certificate rotation all fine.' },
  ] },
  { channel: 'atlas-project', id: 'p-a4', day: -2, at: '09:40', by: 'priya', subject: 'Go/no-go on Wednesday', text: 'Atlas 2.0 go/no-go is Wednesday at 15:00. The gate is red on the load test and the mentions fix. Owners, please update ATL-116 before Tuesday evening.', replies: [
    { id: 'r-a4-1', day: -2, at: '10:05', by: 'aaryan', text: 'Mentions fix (PR #63) has the review comments addressed; waiting for Keerthan.' },
    { id: 'r-a4-2', day: -2, at: '10:12', by: 'thiru', text: 'Load test is still blocked on staging capacity.' },
  ] },
  { channel: 'orion-automation', id: 'p-o1', day: -40, at: '16:20', by: 'rohan', subject: 'Cancellation window merged', text: 'The cancellation window is merged (ORI-204, PR #25). Approve → 60-second countdown → execution. Cancelling after that returns TOO_LATE_TO_CANCEL.', replies: [
    { id: 'r-o1-1', day: -40, at: '16:45', by: 'divya', text: 'The countdown UI matches the "Cancellation countdown" frame in Figma.' },
  ] },
  { channel: 'orion-automation', id: 'p-o2', day: -12, at: '11:05', by: 'koushik', subject: 'Approval workflow ready for review', text: 'The approval workflow changes are ready for review. Can someone verify the cancellation window behaviour before we move this into staging?', replies: [
    { id: 'r-o2-1', day: -12, at: '11:20', by: 'aaryan', text: 'I have tested the backend path. The execution remains cancellable until the window expires.' },
    { id: 'r-o2-2', day: -12, at: '11:32', by: 'anjana', text: 'I will cover the worker restart and retry scenarios today.' },
    { id: 'r-o2-3', day: -12, at: '11:40', by: 'nikhil', text: 'I will verify the UI countdown against the server-side window, including a slow network.' },
  ] },
  { channel: 'orion-automation', id: 'p-o3', day: -12, at: '17:15', by: 'anjana', subject: 'ORI-211: duplicate execution after restart', text: 'SEN-305 found a duplicate Jira comment after a fast worker restart — 1 in 31 runs. Logged as ORI-211 and marked as a GA blocker.', replies: [
    { id: 'r-o3-1', day: -12, at: '17:30', by: 'aaryan', text: 'On it. Looks like the claim lease — the old process finishes its request after the restart.' },
    { id: 'r-o3-2', day: -12, at: '17:41', by: 'kavya', text: 'Agreed, it blocks GA.' },
  ] },
  { channel: 'product-design', id: 'p-d1', day: -54, at: '15:30', by: 'laya', subject: 'Timeline v3 for comments', text: 'Timeline v3 is up in the Enterprise Workspace file. Comments by Thursday, please — density first, states second.', replies: [
    { id: 'r-d1-1', day: -45, at: '17:10', by: 'divya', text: 'Compact variant with the collapsible evidence preview is added next to the current one.' },
  ] },
  { channel: 'product-design', id: 'p-d2', day: -16, at: '14:10', by: 'laya', subject: 'Overview: reasons in the badge row', text: 'Overview update: the status reasons are now in the badge row (usability fix), and Kavya\'s softer "at risk" wording is in the copy frame.', replies: [
    { id: 'r-d2-1', day: -16, at: '14:35', by: 'kavya', text: 'Looks good. Sneha, the strings are in CAN-112.' },
  ] },
  { channel: 'quality-assurance', id: 'p-q1', day: -34, at: '12:00', by: 'anjana', subject: 'Nightly pass rate: 63% → 89%', text: 'The nightly pass rate went from 63% to 89% in three weeks. Quarantine and the staging refresh did most of it. Thank you, Nikhil and Thiru.', replies: [
    { id: 'r-q1-1', day: -34, at: '12:08', by: 'nikhil', text: 'Next: per-suite tenants (SEN-307), which should fix most of what is left.' },
    { id: 'r-q1-2', day: -34, at: '12:30', by: 'koushik', text: 'Great work, everyone.' },
  ] },
  { channel: 'quality-assurance', id: 'p-q2', day: -7, at: '09:15', by: 'anjana', subject: 'Nightly results are back', text: 'The nightly suite was timing out; Thiru raised the limit to 120 minutes until SEN-307 lands. Results are back.', replies: [
    { id: 'r-q2-1', day: -7, at: '09:40', by: 'thiru', text: 'Two complete nights so far.' },
  ] },
  { channel: 'release-coordination', id: 'p-r1', day: -16, at: '16:30', by: 'priya', subject: 'Atlas 2.0 beta checklist', text: 'The Atlas 2.0 beta checklist is in ATL-116. Every line has an owner and a date — please keep your line current.', replies: [
    { id: 'r-r1-1', day: -16, at: '16:50', by: 'rohan', text: 'SSO guides are ATL-119; aiming for the end of next week.' },
  ] },
  { channel: 'release-coordination', id: 'p-r2', day: -9, at: '16:10', by: 'priya', subject: 'Orion GA date', text: 'Orion GA moves by at least a week because of ORI-211. The new date will be set at the checkpoint on Friday.', replies: [
    { id: 'r-r2-1', day: -9, at: '16:40', by: 'kavya', text: 'Pilot sponsors are informed.' },
  ] },
  { channel: 'leadership', id: 'p-l1', day: -31, at: '19:00', by: 'kavya', subject: 'Monthly pilot update sent', text: 'The monthly pilot update went to all three sponsors. Logistics asked about tablet support — that is CAN-119, scheduled after the overview.', replies: [] },
  { channel: 'leadership', id: 'p-l2', day: -6, at: '13:20', by: 'koushik', subject: 'Staging capacity', text: 'Staging capacity is now on the critical path for the Atlas go/no-go. Siddharth, where are we with finance?', replies: [
    { id: 'r-l2-1', day: -2, at: '11:05', by: 'siddharth', text: 'Finance approved it as an exception, but procurement needs the vendor quote re-issued for a two-week term. Thiru, can you get the vendor to re-issue it by Monday?' },
    { id: 'r-l2-2', day: -2, at: '11:20', by: 'koushik', text: 'Thanks — let us not lose another week on this.' },
  ] },
];

// ---- Outlook (Koushik's mailbox) ---------------------------------------------------------------
// People outside the company (pilot sponsors) use fictional reserved-domain addresses.
export const EXTERNAL_PEOPLE = {
  northbridge: { name: 'Dana Whitfield', email: 'dana.whitfield@northbridge-bank.example' },
  meridian: { name: 'Omar Haddad', email: 'omar.haddad@meridian-logistics.example' },
};

export const EMAILS = [
  { id: 'm01', folder: 'inbox', day: -75, at: '09:10', from: 'keerthan', to: ['koushik'], cc: ['aaryan', 'anjana', 'kavya'], subject: 'Atlas notification architecture — review follow-up', importance: 'normal', thread: 't-atlas-arch',
    body: 'Hi Koushik, following yesterday\'s review: (1) delivery stays asynchronous; (2) idempotency is enforced in the execution layer with a key per event and recipient (ATL-104, Aaryan); (3) guarantee is at-least-once with idempotent delivery, and a 2xx counts as delivered for providers without message ids; (4) delivery status goes into the timeline (Laya, Kavya). Restart regression coverage is ATL-110 (Anjana). I will document the guarantees by Friday next week. — Keerthan' },
  { id: 'm02', folder: 'inbox', day: -66, at: '18:30', from: 'priya', to: ['koushik', 'kavya', 'keerthan'], cc: ['meera'], subject: 'Atlas weekly status — idempotent delivery in staging', importance: 'normal', thread: 't-atlas-status',
    body: 'Status: green. ATL-104 merged today; idempotent dispatch is in staging. Restart suite merges tomorrow. Timeline design review next week. SSO spike recommendation accepted (library chosen, both IdPs tested). Risks: per-tenant rate limiting not started; Pulse alerts needed before production.' },
  { id: 'm03', folder: 'inbox', day: -58, at: '17:45', from: 'laya', to: ['kavya'], cc: ['koushik', 'meera'], subject: 'Design approval: Canvas project overview v2', importance: 'high', thread: 't-canvas-approval',
    body: 'Kavya, the overview v2 is ready in the Canvas file (page "Overview v2"). It follows your status definitions, with reasons under the badge. Could you sign off by Thursday so Sneha can size the build? Open points: tablet layout (separate ticket) and the contrast fixes Anjana raised.' },
  { id: 'm04', folder: 'inbox', day: -56, at: '11:00', from: 'kavya', to: ['laya'], cc: ['koushik', 'meera'], subject: 'RE: Design approval: Canvas project overview v2', importance: 'normal', thread: 't-canvas-approval',
    body: 'Approved from the product side. Please keep the reasons visible without scrolling — it is the number one pilot complaint. Tablet as a separate ticket is fine.' },
  { id: 'm05', folder: 'inbox', day: -50, at: '20:15', from: 'ext:northbridge', to: ['kavya'], cc: ['koushik'], subject: 'Northbridge pilot — SSO and deprovisioning questions', importance: 'normal', thread: 't-northbridge-sso',
    body: 'Hello Kavya, our security team reviewed the SSO plan. SAML with Okta is fine for the beta. They need to know how and when SCIM deprovisioning will be available — please include a date in your response. Best regards, Dana' },
  { id: 'm06', folder: 'inbox', day: -34, at: '19:40', from: 'kavya', to: ['ext:northbridge', 'ext:meridian'], cc: ['koushik', 'priya'], subject: 'Arclight monthly pilot update — October', importance: 'normal', thread: 't-pilot-update',
    body: 'Highlights: idempotent notification delivery live in staging with zero duplicates across 23 restart runs; activity timeline with delivery states in final design; SSO working against Entra ID and Okta. Next month: per-tenant rate limiting, SSO admin screen, beta checklist. SCIM provisioning is planned after general availability.' },
  { id: 'm07', folder: 'inbox', day: -23, at: '18:20', from: 'kavya', to: ['ext:meridian'], cc: ['koushik', 'keerthan'], subject: 'Summary of Wednesday\'s notification delay', importance: 'normal', thread: 't-meridian-incident',
    body: 'Omar, on Wednesday notifications in your workspace were delayed for about twelve minutes when a large announcement coincided with a slow mail relay. Our new monitoring detected it within seven minutes. We have shortened relay timeouts, isolated slow providers, and per-tenant rate limiting is in final testing for the beta.' },
  { id: 'm08', folder: 'inbox', day: -21, at: '16:00', from: 'anjana', to: ['koushik', 'meera', 'laya'], cc: ['sneha'], subject: 'QA sign-off: shared timeline component release', importance: 'normal', thread: 't-timeline-signoff',
    body: 'QA sign-off for the shared timeline component (canvas-frontend #80, CAN-113 / ATL-108): delivery states verified in Atlas staging, admin-only retry details verified, contrast within AA after the token change, reconnect duplicate fix still holding. No open defects.' },
  { id: 'm09', folder: 'inbox', day: -16, at: '19:05', from: 'priya', to: ['koushik', 'keerthan', 'kavya', 'anjana', 'meera', 'laya', 'siddharth'], cc: [], subject: 'Atlas 2.0 beta — release plan and go/no-go date', importance: 'high', thread: 't-atlas-beta',
    body: 'Beta on 1 December; go/no-go the Wednesday before. Gate: per-tenant rate limiting load test (blocked on staging capacity), SSO with admin guides, restart suite, mentions fix. Audit export likely moves to 2.1 (Kavya confirming). Checklist with owners: ATL-116.' },
  { id: 'm10', folder: 'inbox', day: -9, at: '18:45', from: 'priya', to: ['koushik'], cc: ['kavya'], subject: 'Orion GA date update', importance: 'high', thread: 't-orion-ga',
    body: 'Koushik, after today\'s readiness review Orion GA moves by at least a week (ORI-211, duplicate execution after restart). Could you confirm the revised timeline personally with the two bank sponsors before the checkpoint? They were promised GA in December and will want to hear it from you.' },
  { id: 'm11', folder: 'inbox', day: -8, at: '10:30', from: 'siddharth', to: ['koushik'], cc: ['thiru', 'priya'], subject: 'Staging capacity request — finance status', importance: 'normal', thread: 't-staging-capacity',
    body: 'Finance wants the staging database increase in the next budget cycle. I am asking for an exception as a two-week item, since it is temporary. I will update you by Wednesday.' },
  { id: 'm12', folder: 'inbox', day: -5, at: '17:55', from: 'arjun', to: ['koushik', 'meera'], cc: [], subject: 'Nova PII redaction — first audit sample results', importance: 'normal', thread: 't-nova-pii',
    body: 'First weekly audit sample: 100 model inputs checked by hand. Structured fields: 0 leaks. Free text: 2 leaked first names (both in quoted e-mail signatures). Fix in progress in PR #11; target remains zero.' },
  { id: 'm13', folder: 'inbox', day: -3, at: '18:10', from: 'anjana', to: ['koushik', 'keerthan', 'kavya', 'priya'], cc: ['nikhil', 'thiru'], subject: 'Release gates for Atlas 2.0, Orion GA and Canvas — proposal', importance: 'normal', thread: 't-gates',
    body: 'Following today\'s gate review: Atlas gate is defined and currently red (load test, mentions fix). Orion gate needs a consecutive-runs check (twenty green SEN-305 runs). Canvas gate: visual baseline and axe scan with zero critical findings. Priya is documenting the override process.' },
  { id: 'm14', folder: 'inbox', day: -1, at: '12:20', from: 'priya', to: ['koushik'], cc: [], subject: 'Atlas go/no-go pack — draft for your review', importance: 'high', thread: 't-gonogo',
    body: 'Draft go/no-go pack attached: gate status, open risks (load test blocked on staging capacity; mentions fix in review), and my recommendation. Could you review it by Tuesday evening so I can circulate it before Wednesday?', attachments: [{ name: 'Atlas-2.0-go-no-go-pack-draft.pdf', size: 412318 }] },
  { id: 'm15', folder: 'sent', day: -27, at: '08:45', from: 'koushik', to: ['keerthan', 'meera', 'kavya', 'laya', 'anjana', 'priya', 'siddharth'], cc: [], subject: 'Leadership update: Q4 at the halfway mark', importance: 'normal', thread: 't-q4-half',
    body: 'Halfway through Q4: Atlas on track with one capacity risk, Orion on track, Canvas slightly behind on contrast fixes, Sentinel ahead, Nova at risk on labelling (now recovering), Pulse launching in two weeks, Horizon discovery next week. Thank you all — the pilots have noticed the reliability work.' },
];

// ---- Action items from these sources (no meeting) ----------------------------------------------
// source: { type: 'jira_comment', issue, comment (index) } | { type: 'github_comment', pr: 'repo#n', review (index) }
//         | { type: 'figma_comment', file, comment (id) } | { type: 'teams_message', channel, post, reply? }
//         | { type: 'outlook_email', email (id) }
export const SOURCE_ITEMS = [
  { key: 'src-faq-workaround', source: { type: 'jira_comment', issue: 'ATL-112', comment: 0 }, owner: 'kavya', project: 'atlas', title: 'Document the digest time-zone workaround in the pilot FAQ', description: 'Until ATL-112 is fixed, explain how to shift the digest hour to the UTC equivalent.', due: -7, priority: 'medium', category: 'communication_required', status: 'done', started: -9, done: -7 },
  { key: 'src-nightly-timeout', source: { type: 'jira_comment', issue: 'SEN-306', comment: 0 }, owner: 'thiru', project: 'sentinel', title: 'Raise the nightly suite timeout to 120 minutes until SEN-307 lands', description: 'So the nightly suite completes and reports results every night.', due: -7, priority: 'medium', category: 'blocker_resolution', status: 'done', started: -8, done: -7 },
  { key: 'src-label-reminder', source: { type: 'jira_comment', issue: 'NOV-407', comment: 0 }, owner: 'kavya', project: 'nova', title: 'Send account managers a labelling reminder with a progress chart', description: 'The evaluation set is at 310 of 500 labelled accounts.', due: -3, priority: 'medium', category: 'follow_up', status: 'todo' },
  { key: 'src-cert-expiry', source: { type: 'github_comment', pr: 'atlas-platform#58', review: 0 }, owner: 'rohan', project: 'atlas', title: 'Add certificate expiry warnings to the SSO admin screen', description: 'Warn admins before an IdP signing certificate expires, so SSO does not break silently.', due: -2, priority: 'high', category: 'code_implementation', status: 'in_progress', started: -9, jira: 'ATL-106' },
  { key: 'src-reason-strings', source: { type: 'github_comment', pr: 'canvas-frontend#78', review: 0 }, owner: 'sneha', project: 'canvas', title: 'Switch the overview status reasons to the new wording', description: 'The layout PR still uses the old strings; use Kavya\'s softer wording from the copy frame.', due: -1, priority: 'low', category: 'review_request', status: 'done', started: -4, done: -3, jira: 'CAN-112' },
  { key: 'src-trend-markers', source: { type: 'figma_comment', file: 'NvAiNt3lL1g4cX', comment: '7720102' }, owner: 'divya', project: 'nova', title: 'Show labelled outcome markers on the Nova trend line', description: 'Lets the team sanity-check the model visually during evaluation; Arjun adds label and date to the trend points.', due: -14, priority: 'low', category: 'design_correction', status: 'done', started: -21, done: -15 },
  { key: 'src-executing-colour', source: { type: 'figma_comment', file: 'OrNaPpR0v4lX7Q', comment: '7730102' }, owner: 'divya', project: 'orion', title: 'Use blue for the "executing" badge in the Orion approval experience', description: 'Amber is reserved for awaiting approval (a person must act).', due: -44, priority: 'low', category: 'design_correction', status: 'done', started: -47, done: -44 },
  { key: 'src-countdown-verify', source: { type: 'teams_message', channel: 'orion-automation', post: 'p-o2', reply: 'r-o2-3' }, owner: 'nikhil', project: 'orion', title: 'Verify the approval countdown against the server-side cancellation window', description: 'Including a slow network, before the approval workflow moves to staging.', due: -11, priority: 'medium', category: 'review_request', status: 'done', started: -12, done: -11 },
  { key: 'src-sso-middleware', source: { type: 'teams_message', channel: 'atlas-project', post: 'p-a3' }, owner: 'rohan', project: 'atlas', title: 'Check the SSO login flow with the new rate-limiting middleware order', description: 'Rebased rate limiting changes the middleware order; verify Entra ID and Okta login.', due: -4, priority: 'medium', category: 'review_request', status: 'done', started: -5, done: -4 },
  { key: 'src-vendor-quote', source: { type: 'teams_message', channel: 'leadership', post: 'p-l2', reply: 'r-l2-1' }, owner: 'thiru', project: 'atlas', title: 'Get the vendor to re-issue the staging capacity quote for a two-week term', description: 'Finance approved the increase as an exception; procurement needs the re-issued quote.', due: 1, priority: 'high', category: 'follow_up', status: 'todo', review: 'pending' },
  { key: 'src-ga-sponsors', source: { type: 'outlook_email', email: 'm10' }, owner: 'koushik', project: 'orion', title: 'Confirm the revised Orion GA timeline personally with the two bank sponsors', description: 'GA moves by at least a week for ORI-211; sponsors were promised December.', due: 4, priority: 'high', category: 'communication_required', status: 'todo' },
  { key: 'src-scim-date', source: { type: 'outlook_email', email: 'm05' }, owner: 'kavya', project: 'atlas', title: 'Reply to Northbridge with a date for SCIM deprovisioning', description: 'Their security team needs a committed date for SCIM after GA.', due: -46, priority: 'medium', category: 'communication_required', status: 'done', started: -49, done: -47 },
  { key: 'src-gonogo-review', source: { type: 'outlook_email', email: 'm14' }, owner: 'koushik', project: 'atlas', title: 'Review the Atlas go/no-go pack draft by Tuesday evening', description: 'Gate status, open risks and Priya\'s recommendation before Wednesday\'s go/no-go.', due: 2, priority: 'high', category: 'review_request', status: 'todo', review: 'pending' },
];
