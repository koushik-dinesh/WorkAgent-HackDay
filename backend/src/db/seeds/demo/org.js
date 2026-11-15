// Arclight Labs: the organisation of the development dataset (docs/SEED_DATA_ARCHITECTURE.md).
// Dates are day offsets from the anchor (config.js). Seven primary people use the addresses they
// were given; the others use the company domain (SEED_COMPANY_DOMAIN).
import { DOMAIN, KAVYA_EMAIL } from './config.js';

export const COMPANY = 'Arclight Labs';

export const DEPARTMENTS = [
  { key: 'engineering', name: 'Engineering' },
  { key: 'product', name: 'Product & Design' },
  { key: 'qa', name: 'Quality Assurance' },
  { key: 'ops', name: 'Business Operations' },
];

// role: WorkAgent role (admin | manager | employee). manager: reporting line (people key).
export const PEOPLE = [
  { key: 'koushik', name: 'Koushik Dinesh', email: 'hello2koushik@gmail.com', title: 'Chief Technology Officer', dept: 'engineering', role: 'admin', manager: null, joined: -1460, aliases: ['Koushik', 'KD'], skills: ['Distributed systems', 'Platform architecture', 'Engineering leadership', 'Technical strategy'] },
  { key: 'keerthan', name: 'Keerthan Vinay', email: 'keerthanvinay@gmail.com', title: 'Principal Engineer, Platform', dept: 'engineering', role: 'manager', manager: 'koushik', joined: -1130, aliases: ['Keerthan'], skills: ['Event-driven architecture', 'Go', 'Node.js', 'Reliability engineering', 'Code review'] },
  { key: 'aaryan', name: 'Aaryan Sharma', email: 'aarayan@gmail.com', title: 'Senior Backend Engineer', dept: 'engineering', role: 'employee', manager: 'keerthan', joined: -720, aliases: ['Aaryan'], skills: ['Node.js', 'MySQL', 'Queues and workers', 'API design'] },
  { key: 'thiru', name: 'Thiru Vikram', email: 'vikram@gmail.com', title: 'Site Reliability Engineer', dept: 'engineering', role: 'employee', manager: 'keerthan', joined: -540, aliases: ['Thiru'], skills: ['Kubernetes', 'OpenTelemetry', 'Terraform', 'Incident response', 'Load testing'] },
  { key: 'meera', name: 'Meera Iyer', email: `meera.iyer@${DOMAIN}`, title: 'Engineering Manager, Application Development', dept: 'engineering', role: 'manager', manager: 'koushik', joined: -910, aliases: ['Meera'], skills: ['People management', 'Delivery planning', 'React', 'Python'] },
  { key: 'rohan', name: 'Rohan Mehta', email: `rohan.mehta@${DOMAIN}`, title: 'Full-Stack Engineer', dept: 'engineering', role: 'employee', manager: 'meera', joined: -430, aliases: ['Rohan'], skills: ['TypeScript', 'React', 'Node.js', 'SAML and OIDC'] },
  { key: 'sneha', name: 'Sneha Reddy', email: `sneha.reddy@${DOMAIN}`, title: 'Senior Frontend Engineer', dept: 'engineering', role: 'employee', manager: 'meera', joined: -610, aliases: ['Sneha'], skills: ['React', 'Design systems', 'Accessibility', 'Data visualisation'] },
  { key: 'arjun', name: 'Arjun Nair', email: `arjun.nair@${DOMAIN}`, title: 'Machine Learning Engineer', dept: 'engineering', role: 'employee', manager: 'meera', joined: -300, aliases: ['Arjun'], skills: ['Python', 'Data pipelines', 'LLM evaluation', 'Feature engineering'] },
  { key: 'kavya', name: 'Kavya N', email: KAVYA_EMAIL, title: 'Senior Product Manager', dept: 'product', role: 'manager', manager: 'koushik', joined: -830, aliases: ['Kavya'], skills: ['Product discovery', 'Requirements', 'Enterprise SaaS', 'Analytics'] },
  { key: 'laya', name: 'Laya Subaraminan', email: 'layaa@gmail.com', title: 'Design Lead', dept: 'product', role: 'manager', manager: 'koushik', joined: -770, aliases: ['Laya'], skills: ['Interaction design', 'Design systems', 'User research', 'Figma'] },
  { key: 'divya', name: 'Divya Menon', email: `divya.menon@${DOMAIN}`, title: 'Product Designer', dept: 'product', role: 'employee', manager: 'laya', joined: -250, aliases: ['Divya'], skills: ['Visual design', 'Prototyping', 'Accessibility', 'Dashboard design'] },
  { key: 'anjana', name: 'Anjana Krithika', email: 'anjana@gmail.com', title: 'QA Lead', dept: 'qa', role: 'manager', manager: 'koushik', joined: -650, aliases: ['Anjana'], skills: ['Test strategy', 'Playwright', 'API testing', 'Release management'] },
  { key: 'nikhil', name: 'Nikhil Rao', email: `nikhil.rao@${DOMAIN}`, title: 'QA Automation Engineer', dept: 'qa', role: 'employee', manager: 'anjana', joined: -60, aliases: ['Nikhil'], skills: ['Playwright', 'k6', 'CI pipelines', 'Contract testing'] },
  { key: 'priya', name: 'Priya Raghavan', email: `priya.raghavan@${DOMAIN}`, title: 'Program Manager', dept: 'ops', role: 'manager', manager: 'koushik', joined: -560, aliases: ['Priya'], skills: ['Program management', 'Release coordination', 'Risk management', 'Stakeholder communication'] },
  { key: 'siddharth', name: 'Siddharth Kulkarni', email: `siddharth.kulkarni@${DOMAIN}`, title: 'Business Operations Manager', dept: 'ops', role: 'manager', manager: 'koushik', joined: -690, aliases: ['Siddharth', 'Sid'], skills: ['Business operations', 'Customer onboarding', 'Vendor management', 'Forecasting'] },
];

export const TEAMS = [
  { key: 'platform', name: 'Platform Engineering', dept: 'engineering', lead: 'keerthan', members: ['aaryan', 'thiru'], description: 'Owns the event pipeline, background workers, notification delivery, observability and the shared infrastructure every product team builds on.' },
  { key: 'appdev', name: 'Application Development', dept: 'engineering', lead: 'meera', members: ['rohan', 'sneha', 'arjun'], description: 'Builds the customer-facing web application, enterprise identity features and the intelligence features in Nova.' },
  { key: 'strategy', name: 'Product Strategy', dept: 'product', lead: 'kavya', members: ['koushik'], description: 'Product requirements, discovery, prioritisation and the portfolio roadmap.' },
  { key: 'design', name: 'UX & Product Design', dept: 'product', lead: 'laya', members: ['divya'], description: 'Interaction and visual design, the Arclight design system, research and accessibility.' },
  { key: 'quality', name: 'Quality Engineering', dept: 'qa', lead: 'anjana', members: ['nikhil'], description: 'Test strategy, automation, release quality gates and regression coverage across all products.' },
  { key: 'program', name: 'Program Management', dept: 'ops', lead: 'priya', members: [], description: 'Cross-project planning, release coordination, dependency and risk tracking.' },
  { key: 'bizops', name: 'Business Operations', dept: 'ops', lead: 'siddharth', members: [], description: 'Customer onboarding, operational readiness, vendor contracts and business reporting.' },
];
