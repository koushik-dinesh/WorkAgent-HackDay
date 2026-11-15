import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as itemsApi from '../../api/actionItems.js';
import { JiraExport } from './JiraExport.jsx';

vi.mock('../../api/actionItems.js');
afterEach(cleanup);

const item = { id: 7, projectId: 3 };
const targets = [
  { resourceId: 11, name: 'Ops', key: 'OPS', canWrite: true, project: { id: 9, name: 'Ops' } },
  { resourceId: 12, name: 'Payments', key: 'PAY', canWrite: true, project: { id: 3, name: 'Payments' } },
];

describe('JiraExport', () => {
  it('preselects the Jira project mapped to the item’s project and requests the issue', async () => {
    itemsApi.requestActionItemExport.mockResolvedValue({ export: { status: 'queued' } });
    const onRequested = vi.fn();
    render(<JiraExport item={item} targets={targets} exportInfo={null} onRequested={onRequested} />);
    expect(screen.getByLabelText('Jira project').value).toBe('12');
    await userEvent.click(screen.getByRole('button', { name: 'Create Jira issue' }));
    expect(itemsApi.requestActionItemExport).toHaveBeenCalledWith(7, 12);
    expect(onRequested).toHaveBeenCalledWith({ status: 'queued' });
  });

  it('shows the created issue as a link, and notes when it could not be assigned', () => {
    render(<JiraExport item={item} targets={targets} exportInfo={{ status: 'created', externalKey: 'PAY-101', externalUrl: 'https://acme.atlassian.net/browse/PAY-101', assigneeSet: false }} onRequested={() => {}} />);
    expect(screen.getByRole('link', { name: 'PAY-101' }).getAttribute('href')).toBe('https://acme.atlassian.net/browse/PAY-101');
    expect(screen.getByText(/unassigned in Jira/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('explains a read-only connection and does not allow sending', () => {
    render(<JiraExport item={item} targets={[{ ...targets[1], canWrite: false }]} exportInfo={null} onRequested={() => {}} />);
    expect(screen.getByRole('button', { name: 'Create Jira issue' }).disabled).toBe(true);
    expect(screen.getByText(/can only read/)).toBeTruthy();
  });

  it('shows a failure with its reason and offers to try again; API errors are shown', async () => {
    itemsApi.requestActionItemExport.mockRejectedValue(new Error('Jira is not configured on the server'));
    render(<JiraExport item={item} targets={targets} exportInfo={{ status: 'failed', lastError: 'Jira refused the issue because of: duedate' }} onRequested={() => {}} />);
    expect(screen.getByText(/because of: duedate/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again in Jira' }));
    expect(await screen.findByText('Jira is not configured on the server')).toBeTruthy();
  });

  it('without Jira projects, says how to set one up', () => {
    render(<JiraExport item={item} targets={[]} exportInfo={null} onRequested={() => {}} />);
    expect(screen.getByText(/enable a Jira project/)).toBeTruthy();
  });
});
