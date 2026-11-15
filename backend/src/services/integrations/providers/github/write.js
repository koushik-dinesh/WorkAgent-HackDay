// GitHub write operations used by the execution engine (services/execution): issues and comments
// only. WorkAgent never creates commits, branches or pull requests and never changes code.
//
// Allowed only when the GitHub App installation was granted "Issues: Read and write" (the
// installation's own permissions, stored on the connection at connect/refresh time). Both
// operations are idempotent through a hidden marker in the body: a retry after an unknown outcome
// finds the issue/comment it already created instead of creating a second one.
//   POST /repos/{owner}/{repo}/issues                       create an issue (title, body, assignees)
//   POST /repos/{owner}/{repo}/issues/{number}/comments     comment on an issue or pull request
//   GET  /search/issues?q=repo:{o}/{r} "{marker}" in:body   find an earlier attempt
import { ProviderError } from '../../errors.js';
import { installationClient } from './api.js';

export const canWriteIssues = (connection) => connection?.settings?.permissions?.issues === 'write';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const markerOf = (marker) => `<!-- ${marker} -->`;

function requireWrite(ctx, repo) {
  if (!canWriteIssues(ctx.connection)) {
    throw new ProviderError('forbidden', 'GitHub App lacks issues:write', { publicMessage: 'The GitHub App installation can only read issues. Grant “Issues: Read and write” to the App on GitHub, then refresh the connection.' });
  }
  if (!REPO.test(String(repo ?? ''))) throw new ProviderError('invalid_request', 'Repository must be owner/name');
}

async function findByMarker(api, repo, marker, type) {
  const res = await api.get('/search/issues', { query: { q: `repo:${repo} "${marker}" in:body${type === 'issue' ? ' is:issue' : ''}`, per_page: 5 } });
  return res.body?.items?.[0] ?? null;
}

/** @returns { number, url, id, existed } */
export async function createIssue(ctx, { repo, title, body, assignees = [], labels = [], marker }) {
  requireWrite(ctx, repo);
  const api = installationClient(ctx);
  if (marker) {
    const found = await findByMarker(api, repo, marker, 'issue');
    if (found) return { number: found.number, url: found.html_url, id: String(found.id), existed: true };
  }
  const res = await api.request('POST', `/repos/${repo}/issues`, {
    body: { title: String(title).slice(0, 250), body: `${String(body ?? '').slice(0, 60_000)}${marker ? `\n\n${markerOf(marker)}` : ''}`, ...(assignees.length && { assignees }), ...(labels.length && { labels }) },
  });
  return { number: res.body?.number, url: res.body?.html_url ?? null, id: String(res.body?.id ?? ''), existed: false };
}

/** @returns { id, url, existed } */
export async function addComment(ctx, { repo, number, body, marker }) {
  requireWrite(ctx, repo);
  const api = installationClient(ctx);
  if (marker) {
    const comments = await api.get(`/repos/${repo}/issues/${Number(number)}/comments`, { query: { per_page: 100 } });
    const found = (comments.body ?? []).find((c) => String(c.body ?? '').includes(marker));
    if (found) return { id: String(found.id), url: found.html_url, existed: true };
  }
  const res = await api.request('POST', `/repos/${repo}/issues/${Number(number)}/comments`, { body: { body: `${String(body).slice(0, 60_000)}${marker ? `\n\n${markerOf(marker)}` : ''}` } });
  return { id: String(res.body?.id ?? ''), url: res.body?.html_url ?? null, existed: false };
}

/** Read-back for verification. */
export async function getIssue(ctx, { repo, number }) {
  const res = await installationClient(ctx).get(`/repos/${repo}/issues/${Number(number)}`);
  return { number: res.body?.number, state: res.body?.state, url: res.body?.html_url };
}
