// The project portfolio. The schema has name, description, status, owner, start and target dates;
// objective, scope, deliverables, milestones, dependencies, risks and success criteria are written
// into the description as prose (the project page shows it as one block of text).
export const PROJECTS = [
  {
    key: 'atlas',
    name: 'Atlas — Enterprise Collaboration Platform',
    jiraKey: 'ATL',
    repo: 'atlas-platform',
    owner: 'keerthan',
    status: 'active',
    priority: 'Critical',
    start: -95,
    target: 45,
    teams: ['platform', 'appdev', 'design', 'quality'],
    members: ['koushik', 'aaryan', 'thiru', 'rohan', 'sneha', 'kavya', 'laya', 'divya', 'anjana', 'nikhil', 'priya', 'meera'],
    description:
      'Priority: Critical. Atlas is the shared workspace our enterprise customers use to coordinate work across departments: workspaces, roles and permissions, an activity timeline, and notifications that reach people in the app, by e-mail and in chat. ' +
      'Problem: the current notification path runs inside the request, so a slow mail relay or chat webhook delays the API, and a retried request can notify people twice. Enterprise pilots (two banks and a logistics group) have made reliable delivery, SSO and an auditable activity history conditions of their contracts. ' +
      'Objective: ship Atlas 2.0 to the enterprise beta with asynchronous, idempotent notification delivery, visible delivery status, SAML single sign-on and workspace-level permissions. ' +
      'Scope: background notification worker with idempotency keys per event and recipient; delivery states (queued, delivered, failed, retrying) on the activity timeline; per-tenant rate limiting for fan-out; SAML SSO with SCIM provisioning as a follow-on; workspace roles; CSV audit export. Out of scope for 2.0: mobile push and the public API. ' +
      'Deliverables: atlas-platform services and worker, the redesigned activity timeline (with Canvas), the Enterprise Workspace design system file, regression suites owned by Quality Engineering, and an operational runbook. ' +
      'Milestones: architecture sign-off (week 3), asynchronous delivery in staging (week 6), timeline v1 (week 9), SSO beta (week 14), 2.0 beta go/no-go (early December), general availability (end of December). ' +
      'Dependencies: Pulse provides the job-lag metrics and alerts the worker relies on; Canvas owns the shared timeline component; Sentinel provides the release gate; Orion reuses the idempotent dispatch for approved executions. ' +
      'Risks: duplicate delivery during worker restarts (mitigated by idempotency keys and the restart regression suite), SSO configuration differences between identity providers, fan-out spikes for 50,000-member workspaces. ' +
      'Success criteria: p95 API latency under 250 ms with notifications enabled, zero duplicate deliveries in the restart suite, delivery status visible for 100% of notifications, and both pilot customers live on SSO.',
  },
  {
    key: 'orion',
    name: 'Orion — Unified Workflow Automation',
    jiraKey: 'ORI',
    repo: 'orion-workflow-engine',
    owner: 'kavya',
    status: 'active',
    priority: 'High',
    start: -88,
    target: 30,
    teams: ['platform', 'appdev', 'design', 'quality'],
    members: ['koushik', 'aaryan', 'keerthan', 'rohan', 'sneha', 'laya', 'divya', 'anjana', 'nikhil', 'priya', 'thiru'],
    description:
      'Priority: High. Orion turns decisions into executed work: when a meeting or a thread produces an action, Orion prepares the exact change (a Jira issue, a comment, an e-mail, a chat post), shows a reviewer precisely what will happen, and only then executes it. ' +
      'Problem: teams copy action items by hand into four different tools, and the automations that exist today run without review, so one wrong rule once posted forty duplicate tickets. Customers asked for automation they can trust: nothing leaves the system without an approval, and every write is traceable. ' +
      'Objective: a general-availability execution engine where every external write is planned, approved, cancellable for a short window, idempotent, retried safely and audited. ' +
      'Scope: execution plan state machine; approval-aware scheduling with a cancellation window; preview hashing so an approver never approves something that changed; retry with exponential backoff for transient provider failures; large-plan confirmation; approval inbox and execution history UI; policy-based auto-approval for low-risk follow-ups (post-GA). ' +
      'Deliverables: orion-workflow-engine service, approval and execution experience (Figma and Canvas components), GA rollout runbook, audit export. ' +
      'Milestones: PRD sign-off (week 1), state machine (week 4), cancellation window in staging (week 7), approval UX v1 (week 9), release readiness review (week 12), GA (mid-December). ' +
      'Dependencies: Atlas idempotent dispatch for notifications; Sentinel regression coverage for concurrent approvals and duplicate execution; Pulse alerting on execution retries. ' +
      'Risks: duplicate execution after a worker restart (open, ORI-211), approver confusion when previews change, provider rate limits during bulk plans. ' +
      'Success criteria: zero duplicate executions in the restart and concurrency suites, 100% of executions traceable to an approval, median approval-to-execution under two minutes, and fewer than 2% of executions needing a manual retry.',
  },
  {
    key: 'canvas',
    name: 'Canvas — Product Experience Modernization',
    jiraKey: 'CAN',
    repo: 'canvas-frontend',
    owner: 'laya',
    status: 'active',
    priority: 'High',
    start: -82,
    target: 20,
    teams: ['design', 'appdev', 'quality', 'strategy'],
    members: ['koushik', 'divya', 'sneha', 'rohan', 'kavya', 'meera', 'anjana', 'nikhil', 'priya'],
    description:
      'Priority: High. Canvas modernises the product experience every Arclight customer sees first: the project overview, the activity timeline, navigation and the shared component library. ' +
      'Problem: the UX audit found that people need four clicks to learn whether a project is on track, status colours mean different things on different pages, keyboard users lose focus in dialogs, and contrast fails WCAG AA on 31 screens. Enterprise procurement now asks for an accessibility conformance report. ' +
      'Objective: one coherent, accessible experience built on design tokens v2, with a project overview that answers "are we on track, what is blocked, what changed" at a glance. ' +
      'Scope: design tokens v2 and theming; redesigned project overview; shared activity timeline component (used by Atlas); empty states; WCAG 2.2 AA fixes; responsive navigation for tablet widths; Playwright visual regression baseline. Out of scope: mobile apps. ' +
      'Deliverables: canvas-frontend component library and pages, the Project Overview and Activity Timeline Figma file, an accessibility conformance report, and visual regression baselines. ' +
      'Milestones: UX audit readout (week 1), tokens v2 (week 4), overview design approved (week 6), timeline component in Atlas (week 9), accessibility fixes complete (week 12), design QA and handoff (week 13). ' +
      'Dependencies: Atlas delivery-status data for the timeline; Sentinel visual regression in CI; Product Strategy for the overview metrics. ' +
      'Risks: scope creep from page-by-page redesign requests, regressions in older pages that consume the new tokens, and the overview metrics definition still moving. ' +
      'Success criteria: project status understood in one view in usability tests (8 of 10 participants), zero critical accessibility findings, and no visual regressions on the 40 baseline screens.',
  },
  {
    key: 'sentinel',
    name: 'Sentinel — Enterprise Quality Management',
    jiraKey: 'SEN',
    repo: 'sentinel-quality-suite',
    owner: 'anjana',
    status: 'active',
    priority: 'High',
    start: -76,
    target: 40,
    teams: ['quality', 'platform'],
    members: ['koushik', 'nikhil', 'thiru', 'aaryan', 'keerthan', 'sneha', 'priya', 'kavya'],
    description:
      'Priority: High. Sentinel is the quality system behind every Arclight release: regression suites, a flaky-test quarantine, contract tests for integrations, load tests and release gates that decide whether a build may ship. ' +
      'Problem: the nightly suite fails one night in three for reasons unrelated to the change under test, so people stopped trusting red builds; concurrency defects such as duplicate execution reach staging; and release readiness is decided in a meeting from memory. ' +
      'Objective: release decisions based on evidence — trustworthy suites, explicit gates per product, and regression coverage for the failure modes that matter most to enterprise customers. ' +
      'Scope: flaky-test quarantine workflow; release gate dashboard per product; contract tests for notification webhooks; regression coverage for duplicate action execution and concurrent approvals; 50,000-recipient fan-out load test; staging test data management. ' +
      'Deliverables: sentinel-quality-suite (Playwright, k6, contract tests), gate definitions for Atlas, Orion and Canvas, and a weekly quality report. ' +
      'Milestones: QA strategy (week 1), quarantine workflow (week 6), contract tests (week 8), release gate dashboard (week 13), gates enforced for Atlas 2.0 and Orion GA (December). ' +
      'Dependencies: stable staging data from Platform Engineering; Pulse metrics for performance gates; product teams for acceptance criteria. ' +
      'Risks: nightly suite timeouts on large staging data (SEN-306), automation capacity (one automation engineer joined mid-quarter), and gates being bypassed under release pressure. ' +
      'Success criteria: nightly pass rate above 97% excluding quarantined tests, every Atlas and Orion release passing its gate, and no duplicate-execution defect reaching production.',
  },
  {
    key: 'nova',
    name: 'Nova — AI-Powered Customer Intelligence',
    jiraKey: 'NOV',
    repo: 'nova-intelligence',
    owner: 'meera',
    status: 'active',
    priority: 'Medium',
    start: -62,
    target: 75,
    teams: ['appdev', 'strategy', 'design'],
    members: ['koushik', 'arjun', 'kavya', 'divya', 'sneha', 'laya', 'siddharth', 'priya'],
    description:
      'Priority: Medium. Nova gives account teams an early, explainable picture of customer health by combining CRM activity, support tickets, product usage and meeting notes into an account health score with the reasons behind it. ' +
      'Problem: renewals are surprised by churn signals that were visible weeks earlier in support queues and meeting notes; account reviews are assembled by hand from five systems. Business Operations estimates eleven hours per account manager per month spent on this. ' +
      'Objective: an account health score v1 that account managers trust because every score shows its evidence, delivered with an intelligence dashboard. ' +
      'Scope: ingestion of CRM and support signals; extraction with strict validation separated from persistence; PII redaction before any model input; account health score v1 with reasons; intelligence dashboard; an evaluation set of 500 labelled accounts. Out of scope: automated outreach. ' +
      'Deliverables: nova-intelligence pipeline and scoring service, the Intelligence Dashboard design, an evaluation report, and a data-processing addendum for customers. ' +
      'Milestones: discovery (week 1), pipeline architecture (week 3), validation/persistence split (week 5), dashboard exploration (week 6), model evaluation review (week 10), pilot with three account teams (January). ' +
      'Dependencies: Business Operations for CRM access and labelling; Legal review of the PII redaction approach; Canvas components for the dashboard. ' +
      'Risks: label quality and labelling capacity (the evaluation set is behind schedule), duplicate accounts after CRM merges, and customer concerns about model inputs. ' +
      'Success criteria: precision of at least 0.8 on at-risk accounts in the evaluation set, zero unredacted PII in model inputs in audit samples, and account managers rating explanations useful in 4 of 5 reviews.',
  },
  {
    key: 'pulse',
    name: 'Pulse — Engineering Observability Platform',
    jiraKey: 'PUL',
    repo: 'pulse-observability',
    owner: 'keerthan',
    status: 'completed',
    priority: 'High',
    start: -72,
    target: -12,
    teams: ['platform', 'quality'],
    members: ['koushik', 'thiru', 'aaryan', 'anjana', 'priya', 'meera'],
    description:
      'Priority: High (completed). Pulse gave engineering one observability foundation: distributed tracing across the API and background workers, SLO dashboards, and alert routing to the on-call rotation. ' +
      'Problem: before Pulse, a stuck worker queue was noticed by customers first. The September notification delay — fourteen minutes of job lag before anyone knew — made this the top operational risk for Atlas and Orion. ' +
      'Objective: detect queue backlogs and latency regressions within five minutes and route them to the right person with a runbook. ' +
      'Scope: OpenTelemetry tracing for the API and worker; SLO dashboards for API latency and job lag; alert routing to the on-call rotation; a queue-backlog alert at five minutes of lag; runbooks. Out of scope: log retention changes and cost dashboards (moved to Horizon). ' +
      'Deliverables: pulse-observability collectors and dashboards, alert rules, the worker backlog runbook, and the incident review of the September queue backlog. ' +
      'Milestones: kickoff (week 1), tracing in staging (week 3), SLO definitions agreed (week 4), dashboards and alerts live (week 7), launch (week 9), retrospective (week 9). ' +
      'Dependencies: Atlas and Orion worker instrumentation; Sentinel load tests for alert thresholds. ' +
      'Outcome: launched on schedule; backlog detection time fell from fourteen minutes to under three; one follow-up (retry double-counting in the lag metric) fixed before launch. ' +
      'Success criteria met: all production services traced, five SLOs with error budgets, and every page routed with a linked runbook.',
  },
  {
    key: 'horizon',
    name: 'Horizon — Internal Developer Experience',
    jiraKey: 'HOR',
    repo: 'horizon-devtools',
    owner: 'priya',
    status: 'planning',
    priority: 'Medium',
    start: -20,
    target: 100,
    teams: ['platform', 'program'],
    members: ['koushik', 'keerthan', 'thiru', 'meera', 'nikhil', 'aaryan', 'sneha'],
    description:
      'Priority: Medium (planning). Horizon makes it faster and safer for Arclight engineers to ship: shorter CI, preview environments for every pull request, and a golden-path template for new services. ' +
      'Problem: the developer survey (31 responses) ranked CI time (median 23 minutes) and the lack of preview environments as the two biggest drags on delivery; new services take two days to bootstrap and each is set up differently. ' +
      'Objective: CI under ten minutes for the main repositories, an ephemeral preview environment per pull request, and a golden-path template used by every new service. ' +
      'Scope: CI pipeline parallelisation and caching; ephemeral preview environments; golden-path service template with tracing, health checks and deployment wired in; developer portal page. Out of scope: replacing the CI vendor. ' +
      'Deliverables: horizon-devtools (pipeline templates, preview environment controller, service template), a CI timing baseline and a quarterly developer survey. ' +
      'Milestones: discovery workshop (done), scoping review (done), CI timing baseline (week 4), preview environments pilot with Canvas (week 8), golden path v1 (week 12). ' +
      'Dependencies: Platform Engineering capacity after Atlas 2.0, Pulse tracing for the template, cloud budget approval from Business Operations for preview environments. ' +
      'Risks: competing with Atlas 2.0 and Orion GA for platform capacity in December; preview environment cost. ' +
      'Success criteria: median CI time under ten minutes, previews for 90% of Canvas pull requests in the pilot, and a developer satisfaction score up by one point.',
  },
];
