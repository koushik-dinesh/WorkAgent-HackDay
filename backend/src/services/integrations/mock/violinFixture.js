// Fictional organisation for the Microsoft Teams DEVELOPMENT MOCK (docs/integrations/MICROSOFT_TEAMS_MOCK_SETUP.md).
// Everything here is invented: "Violin Technologies", its people (reserved example.com addresses),
// teams, channels, messages and meeting transcripts. Times are offsets from an anchor date that is
// fixed the first time the mock is seeded, so re-seeding produces identical records.
//
// Offsets: `day` = days after the anchor Monday (negative = before), `at` = 'HH:MM' UTC.

export const ORGANISATION = 'Violin Technologies';
export const MOCK_ACCOUNT = 'demo.user@example.com';
export const EMAIL_DOMAIN = 'violin.example.com';

export const DEPARTMENTS = ['Engineering', 'Product', 'Design', 'QA', 'Human Resources', 'Finance', 'Marketing'];

// id, name, department, job title, manager id (null = reports to the CEO / none)
export const EMPLOYEES = [
  ['VT-001', 'Aria Menon', 'Engineering', 'VP Engineering', null],
  ['VT-002', 'Ben Carter', 'Engineering', 'Engineering Manager, Payments', 'VT-001'],
  ['VT-003', 'Priya Raman', 'Engineering', 'Senior Backend Engineer', 'VT-002'],
  ['VT-004', 'Diego Alvarez', 'Engineering', 'Backend Engineer', 'VT-002'],
  ['VT-005', 'Hannah Okoro', 'Engineering', 'Engineering Manager, Platform', 'VT-001'],
  ['VT-006', 'Kenji Watanabe', 'Engineering', 'Platform Engineer', 'VT-005'],
  ['VT-007', 'Leila Haddad', 'Engineering', 'Site Reliability Engineer', 'VT-005'],
  ['VT-008', 'Marcus Lee', 'Engineering', 'Frontend Lead', 'VT-001'],
  ['VT-009', 'Sofia Rossi', 'Engineering', 'Frontend Engineer', 'VT-008'],
  ['VT-010', 'Tomás Silva', 'Engineering', 'Frontend Engineer', 'VT-008'],
  ['VT-011', 'Nadia Petrova', 'Engineering', 'Backend Lead', 'VT-001'],
  ['VT-012', 'Omar Farouk', 'Engineering', 'Backend Engineer', 'VT-011'],
  ['VT-013', 'Grace Kim', 'Design', 'Head of Design', null],
  ['VT-014', 'Lucas Martin', 'Design', 'Product Designer', 'VT-013'],
  ['VT-015', 'Mei Chen', 'Design', 'UX Researcher', 'VT-013'],
  ['VT-016', 'Rachel Adams', 'QA', 'QA Lead', null],
  ['VT-017', 'Samuel Osei', 'QA', 'QA Engineer', 'VT-016'],
  ['VT-018', 'Ivy Nguyen', 'QA', 'QA Automation Engineer', 'VT-016'],
  ['VT-019', 'Daniel Brooks', 'Product', 'Head of Product', null],
  ['VT-020', 'Elena Novak', 'Product', 'Product Manager, Payments', 'VT-019'],
  ['VT-021', 'Felix Wagner', 'Product', 'Product Manager, Platform', 'VT-019'],
  ['VT-022', 'Zara Ali', 'Human Resources', 'HR Business Partner', null],
  ['VT-023', 'Victor Hughes', 'Finance', 'Finance Manager', null],
  ['VT-024', 'Chloe Dubois', 'Marketing', 'Product Marketing Manager', null],
].map(([id, name, department, jobTitle, managerId]) => ({ id, name, department, jobTitle, managerId, email: `${name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/g, '.')}@${EMAIL_DOMAIN}`, aadId: `mock-aad-${id.toLowerCase()}` }));

export const byId = (id) => EMPLOYEES.find((e) => e.id === id);

// WorkAgent projects the mock work belongs to (lead = employee id).
export const PROJECTS = [
  { key: 'payments', name: 'Payments Platform 2.0', lead: 'VT-002', description: 'New payment orchestration, refunds and payouts.' },
  { key: 'platform', name: 'Platform Reliability', lead: 'VT-005', description: 'Kubernetes migration, observability and on-call.' },
  { key: 'checkout', name: 'Checkout Redesign', lead: 'VT-008', description: 'Redesigned checkout and saved cards.' },
  { key: 'release', name: 'Release 4.2', lead: 'VT-020', description: 'November release train.' },
];

// Teams (Microsoft Teams teams and WorkAgent teams), members and channels.
export const TEAMS = [
  { key: 'payments', name: 'Payments Team', lead: 'VT-002', project: 'payments', members: ['VT-003', 'VT-004', 'VT-020', 'VT-014', 'VT-017'], channels: ['General', 'Refunds', 'Incidents'] },
  { key: 'platform', name: 'Platform Engineering', lead: 'VT-005', project: 'platform', members: ['VT-006', 'VT-007', 'VT-021'], channels: ['General', 'Kubernetes Migration', 'On-call'] },
  { key: 'frontend', name: 'Frontend Engineering', lead: 'VT-008', project: 'checkout', members: ['VT-009', 'VT-010', 'VT-014'], channels: ['General', 'Checkout Redesign'] },
  { key: 'backend', name: 'Backend Engineering', lead: 'VT-011', project: 'payments', members: ['VT-012', 'VT-003', 'VT-004'], channels: ['General', 'API Design', 'Code Review'] },
  { key: 'design', name: 'Design Team', lead: 'VT-013', project: 'checkout', members: ['VT-014', 'VT-015'], channels: ['General', 'Design Critique'] },
  { key: 'qa', name: 'QA Team', lead: 'VT-016', project: 'release', members: ['VT-017', 'VT-018'], channels: ['General', 'Release Testing', 'Bug Triage'] },
  { key: 'product', name: 'Product Management', lead: 'VT-019', project: 'release', members: ['VT-020', 'VT-021', 'VT-024'], channels: ['General', 'Roadmap'] },
];

export const channelKey = (team, channel) => `${team}:${channel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

// Channel posts: [team, channel, author, day, 'HH:MM', subject|null, body, replies: [[author, minutesLater, body]], reactions]
export const MESSAGES = [
  ['payments', 'General', 'VT-002', -5, '09:05', 'Sprint 23 goals', 'Sprint 23 goals: ship partial refunds to 10% of merchants, finish the payout reconciliation job, and close the two P1 bugs from last week.', [['VT-020', 12, 'Adding the refund rollout plan to the release notes today.'], ['VT-003', 30, 'Reconciliation job is code complete, needs review from @Diego.']], ['like:3', 'heart:1']],
  ['payments', 'Refunds', 'VT-003', -4, '10:20', null, 'Partial refunds are failing for EUR transactions with three decimal places in the ledger. Root cause: we round before converting minor units. Fix is in PR #482.', [['VT-004', 18, 'Reviewed, one comment on the migration. Otherwise good to merge.'], ['VT-017', 45, 'I will add a regression test for JPY and EUR amounts before we merge.']], ['like:4']],
  ['payments', 'Refunds', 'VT-020', -2, '14:10', 'Decision: refund window', 'Decision from today: partial refunds are allowed within 120 days of capture (was 90). Legal approved. Ben will update the policy flag.', [['VT-002', 5, 'Flag change is scheduled for Wednesday.']], ['check:5']],
  ['payments', 'Incidents', 'VT-004', -3, '02:14', 'INC-311 payout delays', 'INC-311: payouts to two banks are delayed by ~40 minutes because the settlement webhook is retrying. Mitigated by increasing the worker pool. Post-mortem owner: Diego.', [['VT-007', 9, 'Alert threshold for the webhook queue was too high, lowering it to 5 minutes.'], ['VT-002', 300, 'Thanks both. Post-mortem doc by Friday please.']], ['eyes:2']],
  ['platform', 'General', 'VT-005', -5, '08:45', null, 'Reminder: the staging cluster will be read-only from 18:00 to 20:00 UTC on Thursday for the node pool upgrade.', [['VT-021', 20, 'I will tell the product teams in the release channel.']], ['like:6']],
  ['platform', 'Kubernetes Migration', 'VT-006', -4, '11:30', 'Migration status', 'Migration status: 14 of 22 services are on the new cluster. Blocker: the payments service needs the new secrets manager before it can move, and that is waiting on security review.', [['VT-005', 25, 'I will chase security today; target is to unblock by Tuesday.'], ['VT-003', 60, 'Payments can move the week after; we need one day to test the secret rotation.']], ['like:2']],
  ['platform', 'On-call', 'VT-007', -1, '07:55', null, 'Handover: quiet night, one page for disk pressure on logging-3, resolved by rotating old indices. Runbook updated.', [], ['like:3']],
  ['frontend', 'General', 'VT-008', -5, '09:30', null, 'Frontend sync moved to 10:30 today because of the design review.', [['VT-009', 3, 'Works for me.']], []],
  ['frontend', 'Checkout Redesign', 'VT-009', -3, '15:00', 'Saved cards', 'Saved cards UI is behind a feature flag on staging. Known issue: the CVV field loses focus on Safari 17 when the card list re-renders.', [['VT-010', 40, 'I can take the Safari focus bug, I fixed something similar in the address form.'], ['VT-014', 55, 'Design note: the card list should collapse to three items with a "show all" link.']], ['like:2', 'rocket:1']],
  ['frontend', 'Checkout Redesign', 'VT-010', -1, '16:45', null, 'Safari CVV focus bug fixed in PR #519. Needs QA on Safari 17 and iOS 17.', [['VT-018', 30, 'Added to the release test plan, will test tomorrow morning.']], ['check:2']],
  ['backend', 'API Design', 'VT-011', -4, '13:00', 'Payouts API v2', 'Draft of the Payouts API v2 is in the design doc. Open question: do we return settlement batches inline or behind a separate endpoint? Please comment by Thursday.', [['VT-012', 35, 'Separate endpoint. Batches can be large and merchants paginate them.'], ['VT-003', 50, 'Agree with Omar. Also idempotency keys should be required, not optional.']], ['thinking:1', 'like:2']],
  ['backend', 'Code Review', 'VT-012', -2, '10:05', null, 'PR #501 adds idempotency key validation to the payouts endpoint. Needs a second reviewer from payments.', [['VT-004', 22, 'Taking it.']], []],
  ['backend', 'General', 'VT-011', -1, '09:00', null, 'Decision: we standardise on cursor pagination for all new public endpoints. Offset pagination stays only on internal admin APIs.', [['VT-012', 15, 'Updating the API guidelines page.']], ['check:4']],
  ['design', 'Design Critique', 'VT-014', -3, '11:00', 'Checkout v3 mocks', 'Checkout v3 mocks are in Figma. Main change: order summary moves above the payment form on mobile. Feedback welcome until Wednesday.', [['VT-015', 40, 'Usability sessions showed people scroll back up to check totals, so this should help.'], ['VT-013', 90, 'Approved from my side. Please check the contrast of the secondary button.']], ['heart:3']],
  ['design', 'General', 'VT-015', -1, '14:30', null, 'Research readout for saved cards is on Thursday at 15:00. Recording and notes will be in the research repository.', [], ['like:2']],
  ['qa', 'Release Testing', 'VT-016', -2, '09:15', 'Release 4.2 test plan', 'Release 4.2 regression run starts Monday. Coverage: payments refunds, saved cards, payouts API. Samuel owns refunds, Ivy owns automation for saved cards.', [['VT-017', 10, 'Refund test data is ready on staging.'], ['VT-018', 25, 'Automation for saved cards will be green by Tuesday EOD.']], ['like:2']],
  ['qa', 'Bug Triage', 'VT-017', -1, '11:40', 'P1: duplicate refund email', 'P1: customers receive the refund confirmation email twice when a partial refund is retried. Reproducible on staging. Assigning to payments.', [['VT-003', 20, 'Looking now. Likely the retry path does not check the notification idempotency key.'], ['VT-002', 30, 'Priya owns it. This blocks the 4.2 release.']], ['eyes:3']],
  ['product', 'Roadmap', 'VT-019', -4, '16:00', 'Q1 roadmap draft', 'Q1 roadmap draft: payouts API v2 GA, saved cards for all markets, and the merchant analytics beta. Feedback in the doc by Friday.', [['VT-020', 30, 'Payouts GA depends on the Kubernetes migration finishing in December.'], ['VT-024', 60, 'Marketing would like the analytics beta announcement in late February.']], ['like:3']],
  ['product', 'General', 'VT-021', -1, '10:00', null, 'Reminder: roadmap review with leadership is next Wednesday. Slides due Monday noon.', [], []],
].map(([team, channel, author, day, at, subject, body, replies, reactions], i) => ({ id: `mock-msg-${String(i + 1).padStart(3, '0')}`, team, channel, author, day, at, subject, body, replies: replies.map(([a, mins, b], j) => ({ id: `mock-msg-${String(i + 1).padStart(3, '0')}-r${j + 1}`, author: a, minutes: mins, body: b })), reactions }));

// Meetings with multi-speaker transcripts (task assignments, deadlines, blockers, decisions).
// lines: [speakerId, text]; decisions and actionItems describe what the transcript contains (for
// checking extraction), they are not inserted as action items.
export const MEETINGS = [
  {
    key: 'standup', title: 'Daily Engineering Standup', organizer: 'VT-001', team: 'payments', project: 'payments', day: 0, at: '09:00', minutes: 15,
    attendees: ['VT-002', 'VT-003', 'VT-004', 'VT-005', 'VT-006', 'VT-008', 'VT-009', 'VT-011'],
    lines: [
      ['VT-001', 'Good morning everyone. Quick round, blockers first please.'],
      ['VT-003', 'I am working on the duplicate refund email bug. I will have a fix up for review by tomorrow noon.'],
      ['VT-004', 'Payout reconciliation is merged. I am blocked on the post-mortem for INC-311 because I still need the queue metrics from Leila.'],
      ['VT-005', 'I will ask Leila to send the queue metrics to Diego today.'],
      ['VT-006', 'Twelve services left on the old cluster. Payments is still blocked on the secrets manager security review.'],
      ['VT-009', 'Saved cards is on staging. Tomás fixed the Safari focus bug.'],
      ['VT-011', 'Omar, can you update the API guidelines with the cursor pagination decision by Wednesday?'],
      ['VT-001', 'Thanks. Ben, please make sure the refund email fix is in the 4.2 release candidate.'],
      ['VT-002', 'Will do, I will check the release branch on Thursday morning.'],
    ],
    decisions: [], actionItems: ['Priya: fix duplicate refund email by tomorrow noon', 'Hannah: get queue metrics to Diego today', 'Omar: update API guidelines by Wednesday', 'Ben: verify fix in 4.2 RC on Thursday'],
  },
  {
    key: 'payments-arch', title: 'Payments Architecture Review', organizer: 'VT-002', team: 'payments', project: 'payments', day: -3, at: '14:00', minutes: 60,
    attendees: ['VT-003', 'VT-004', 'VT-011', 'VT-012', 'VT-020', 'VT-006'],
    lines: [
      ['VT-002', 'Today we decide how refunds and payouts share the ledger service.'],
      ['VT-003', 'My proposal is one ledger with separate posting types. Two ledgers would double the reconciliation work.'],
      ['VT-011', 'I agree, but we need idempotency keys on every posting, otherwise retries create duplicates like last week.'],
      ['VT-020', 'From the product side we need the ledger to support the 120 day refund window.'],
      ['VT-002', 'Decision: we keep a single ledger with posting types and mandatory idempotency keys.'],
      ['VT-012', 'I will write the migration plan for the posting types by next Friday.'],
      ['VT-004', 'I can prototype the idempotency check in the ledger client this week.'],
      ['VT-006', 'One blocker: the ledger database is still on the old cluster, so load tests have to wait for the migration.'],
      ['VT-002', 'Kenji, please give us a date for the ledger database move by Monday.'],
      ['VT-006', 'Okay, I will send a date by Monday.'],
    ],
    decisions: ['Single ledger with posting types and mandatory idempotency keys'], actionItems: ['Omar: migration plan by next Friday', 'Diego: prototype idempotency check this week', 'Kenji: date for ledger DB move by Monday'],
  },
  {
    key: 'sprint-planning', title: 'Sprint Planning — Sprint 24', organizer: 'VT-020', team: 'payments', project: 'release', day: -7, at: '10:00', minutes: 90,
    attendees: ['VT-002', 'VT-003', 'VT-004', 'VT-014', 'VT-017'],
    lines: [
      ['VT-020', 'Sprint 24 is two weeks. Top priority is the refund rollout to all merchants.'],
      ['VT-002', 'Capacity is lower, Diego is on call next week.'],
      ['VT-003', 'I will take the refund rollout and the feature flag cleanup.'],
      ['VT-004', 'I will finish payout reconciliation and write the INC-311 post-mortem by Friday.'],
      ['VT-014', 'The refund confirmation screen needs a new empty state. I will deliver the design by Wednesday.'],
      ['VT-017', 'I need the refund test accounts on staging before I can start, can someone create them?'],
      ['VT-003', 'I will create the test accounts today.'],
      ['VT-020', 'Decision: the merchant analytics beta moves to Sprint 25.'],
    ],
    decisions: ['Merchant analytics beta moves to Sprint 25'], actionItems: ['Priya: refund rollout + flag cleanup', 'Diego: post-mortem by Friday', 'Lucas: empty state design by Wednesday', 'Priya: create test accounts today'],
  },
  {
    key: 'roadmap', title: 'Product Roadmap Discussion', organizer: 'VT-019', team: 'product', project: 'release', day: -4, at: '16:00', minutes: 60,
    attendees: ['VT-020', 'VT-021', 'VT-024', 'VT-001', 'VT-013'],
    lines: [
      ['VT-019', 'Let us finalise the Q1 roadmap themes.'],
      ['VT-021', 'Payouts API v2 general availability depends on the Kubernetes migration finishing in December.'],
      ['VT-001', 'Engineering can commit to the migration by December 15 if the security review is done this week.'],
      ['VT-024', 'Marketing needs the analytics beta date by the end of the month to plan the launch.'],
      ['VT-019', 'Decision: Q1 themes are payouts GA, saved cards everywhere, and the analytics beta.'],
      ['VT-020', 'I will write the one-pager for saved cards in all markets by next Tuesday.'],
      ['VT-013', 'Design will need two weeks for the analytics beta research, starting in January.'],
      ['VT-019', 'Felix, please prepare the leadership slides by Monday noon.'],
      ['VT-021', 'Sure, Monday noon.'],
    ],
    decisions: ['Q1 themes: payouts GA, saved cards everywhere, analytics beta'], actionItems: ['Elena: saved cards one-pager by next Tuesday', 'Felix: leadership slides by Monday noon'],
  },
  {
    key: 'design-review', title: 'Design Review — Checkout v3', organizer: 'VT-013', team: 'design', project: 'checkout', day: -2, at: '11:00', minutes: 45,
    attendees: ['VT-014', 'VT-015', 'VT-008', 'VT-009', 'VT-020'],
    lines: [
      ['VT-014', 'This is checkout v3. The order summary is above the payment form on mobile.'],
      ['VT-015', 'In the usability study six of eight people scrolled back up to check the total, so this fixes a real problem.'],
      ['VT-008', 'Engineering concern: the sticky summary might overlap the keyboard on small Android phones.'],
      ['VT-013', 'Lucas, please test the sticky summary on a small Android device and report back by Thursday.'],
      ['VT-014', 'Will do.'],
      ['VT-009', 'I can build the summary component behind the existing checkout flag next sprint.'],
      ['VT-013', 'Decision: we go with the summary above the form, with a collapsed variant on screens under 360 pixels.'],
      ['VT-020', 'I will update the acceptance criteria in the checkout epic today.'],
    ],
    decisions: ['Summary above the form, collapsed under 360 px'], actionItems: ['Lucas: Android test by Thursday', 'Sofia: build component next sprint', 'Elena: update acceptance criteria today'],
  },
  {
    key: 'qa-readiness', title: 'QA Release Readiness — 4.2', organizer: 'VT-016', team: 'qa', project: 'release', day: -1, at: '15:00', minutes: 30,
    attendees: ['VT-017', 'VT-018', 'VT-002', 'VT-008', 'VT-020'],
    lines: [
      ['VT-016', 'Release 4.2 readiness. Two open P1 bugs.'],
      ['VT-017', 'The duplicate refund email is still open, it blocks the release.'],
      ['VT-002', 'Priya is fixing it, the fix will be in the release candidate on Thursday.'],
      ['VT-018', 'Saved cards automation is ninety percent green. The Safari tests are flaky, I will stabilise them by tomorrow.'],
      ['VT-008', 'The Safari focus fix is merged, please retest on iOS 17.'],
      ['VT-017', 'I will retest Safari and iOS tomorrow morning.'],
      ['VT-016', 'Decision: go or no-go meeting stays on Friday at ten. If the P1 is not fixed by then we slip by one week.'],
      ['VT-020', 'I will prepare the customer communication in case we slip.'],
    ],
    decisions: ['Go/no-go Friday 10:00; slip one week if the P1 is open'], actionItems: ['Ivy: stabilise Safari tests by tomorrow', 'Samuel: retest Safari/iOS tomorrow', 'Elena: customer communication for slip'],
  },
  {
    key: 'management', title: 'Weekly Management Meeting', organizer: 'VT-001', team: 'product', project: 'release', day: -4, at: '09:00', minutes: 60,
    attendees: ['VT-019', 'VT-013', 'VT-016', 'VT-022', 'VT-023', 'VT-005'],
    lines: [
      ['VT-001', 'Headcount, budget and the release status.'],
      ['VT-022', 'Two engineering offers are out. Onboarding plans are needed from each hiring manager by next Wednesday.'],
      ['VT-005', 'I will send the platform onboarding plan by next Wednesday.'],
      ['VT-023', 'Cloud spend is eleven percent over budget because of running both clusters during the migration.'],
      ['VT-001', 'That is expected until December. Hannah, please share a decommission plan for the old cluster with Victor by Friday.'],
      ['VT-005', 'Okay, by Friday.'],
      ['VT-016', 'Release 4.2 is at risk because of one P1 bug.'],
      ['VT-001', 'Decision: we accept the cloud overspend until December 31 and review it again in January.'],
    ],
    decisions: ['Accept cloud overspend until Dec 31, review in January'], actionItems: ['Hannah: onboarding plan by next Wednesday', 'Hannah: decommission plan to Victor by Friday'],
  },
  {
    key: 'api-review', title: 'Backend API Review — Payouts v2', organizer: 'VT-011', team: 'backend', project: 'payments', day: -1, at: '13:00', minutes: 45,
    attendees: ['VT-012', 'VT-003', 'VT-004', 'VT-021'],
    lines: [
      ['VT-011', 'Review of the Payouts API v2 draft.'],
      ['VT-012', 'Settlement batches get their own endpoint with cursor pagination.'],
      ['VT-003', 'Idempotency keys must be required on create payout. Otherwise merchants retry and we pay twice.'],
      ['VT-021', 'Merchants asked for webhooks when a batch settles.'],
      ['VT-011', 'Decision: idempotency keys are required, batches have their own endpoint, and we add a batch settled webhook.'],
      ['VT-012', 'I will update the OpenAPI spec by Wednesday.'],
      ['VT-004', 'I will write the webhook design section by Friday.'],
      ['VT-003', 'I am blocked on the sandbox environment, it still runs the old schema. Can platform refresh it?'],
      ['VT-011', 'I will raise the sandbox refresh with Hannah today.'],
    ],
    decisions: ['Required idempotency keys, separate batch endpoint, batch settled webhook'], actionItems: ['Omar: OpenAPI spec by Wednesday', 'Diego: webhook design by Friday', 'Nadia: raise sandbox refresh today'],
  },
  {
    key: 'frontend-review', title: 'Frontend Integration Review', organizer: 'VT-008', team: 'frontend', project: 'checkout', day: -2, at: '16:00', minutes: 30,
    attendees: ['VT-009', 'VT-010', 'VT-003', 'VT-014'],
    lines: [
      ['VT-008', 'Integration of saved cards with the new tokenisation endpoint.'],
      ['VT-010', 'The tokenisation endpoint returns 409 when a card is already saved. The UI shows a generic error.'],
      ['VT-003', 'The 409 body includes the existing card id, so the UI can select it instead of failing.'],
      ['VT-009', 'Then I will handle the 409 by selecting the existing card. I can do it by Tuesday.'],
      ['VT-014', 'Please show a small toast saying the card was already saved.'],
      ['VT-008', 'Decision: duplicate cards are selected silently with an informational toast.'],
      ['VT-010', 'I will add end to end tests for saved cards by Thursday.'],
    ],
    decisions: ['Duplicate cards are selected with an informational toast'], actionItems: ['Sofia: handle 409 by Tuesday', 'Tomás: e2e tests by Thursday'],
  },
  {
    key: 'retro', title: 'Release Retrospective — 4.1', organizer: 'VT-020', team: 'qa', project: 'release', day: -6, at: '15:30', minutes: 45,
    attendees: ['VT-016', 'VT-017', 'VT-002', 'VT-008', 'VT-005'],
    lines: [
      ['VT-020', 'Retrospective for release 4.1. What went well and what did not.'],
      ['VT-016', 'Regression testing took four days because test data was missing on staging.'],
      ['VT-005', 'The release was delayed by the certificate renewal. We need an alert thirty days before expiry.'],
      ['VT-005', 'I will add the certificate expiry alert by next Monday.'],
      ['VT-017', 'I will write a script that seeds refund test data on staging by the end of next week.'],
      ['VT-002', 'Release notes were late again. Product should own them.'],
      ['VT-020', 'Agreed. Decision: product owns release notes from 4.2 onwards, drafted two days before the go or no-go.'],
      ['VT-008', 'Frontend would like a code freeze one day earlier.'],
      ['VT-020', 'Let us try it for 4.2 and review in the next retro.'],
    ],
    decisions: ['Product owns release notes from 4.2', 'Trial an earlier code freeze for 4.2'], actionItems: ['Hannah: certificate alert by next Monday', 'Samuel: test data script by end of next week'],
  },
].map((m) => ({ ...m, id: `mock-meeting-${m.key}` }));

/** WebVTT with <v Speaker> tags, ~6 s per line. */
export function meetingVtt(meeting) {
  const ts = (s) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000`;
  const cues = meeting.lines.map(([who, text], i) => `${ts(i * 7 + 1)} --> ${ts(i * 7 + 6)}\n<v ${byId(who).name}>${text}</v>`);
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}
