import { expect, test } from '@playwright/test';

const headSha = 'a'.repeat(40);
test('shows PR commits and code changes from GitHub', async ({ page }) => {
  const pr = {
    number: 143, title: 'Review example', body: 'Ready for review',
    url: 'https://github.com/owner/repo/pull/143', state: 'OPEN', isDraft: false,
    reviewDecision: 'APPROVED', checks: [{ name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  };
  await page.route('**/api/session', (route) => route.fulfill({ json: { csrfToken: 'test-csrf' } }));
  const item = { number: 143, title: pr.title, state: 'OPEN', isDraft: false, headRefName: 'feature/review', baseRefName: 'dev', updatedAt: '', url: pr.url, reviewDecision: 'APPROVED', checkStatus: 'success' };
  await page.route('**/api/prs?state=*', (route) => route.fulfill({ json: { items: [item] } }));
  await page.route('**/api/prs/143', (route) => route.fulfill({ json: { pr: { ...item, body: pr.body, checks: pr.checks }, comments: [] } }));
  await page.route('**/api/prs/143/commits', (route) => route.fulfill({ json: { commits: [{ sha: headSha, subject: 'Improve review', author: 'Alice', authoredAt: '2026-10-16T10:00:00Z' }] } }));
  await page.route('**/api/prs/143/files', (route) => route.fulfill({ json: { files: [{ path: 'src/example.ts', sha: 'file-sha', status: 'modified', additions: 1, deletions: 1, patchAvailable: true, isBinary: false, hunks: [{ header: '@@ -1 +1 @@', lines: [{ kind: 'remove', oldNumber: 1, newNumber: null, content: 'old line' }, { kind: 'add', oldNumber: null, newNumber: 1, content: 'new line' }] }] }] } }));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Review example', exact: true })).toBeVisible();
  await expect(page.getByText('APPROVED', { exact: true })).toBeVisible();
  await expect(page.getByText('SUCCESS', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Commits' }).click();
  await expect(page.getByText('Improve review')).toBeVisible();
  await expect(page.getByText('Alice')).toBeVisible();
  await page.getByRole('tab', { name: 'Files changed' }).click();
  await page.getByRole('link', { name: 'src/example.ts' }).click();
  await expect(page).toHaveURL(/#pr-143-file-0$/);
  await expect(page.getByText('new line')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Viewed src/example.ts' }).click();
  await expect(page.getByRole('checkbox', { name: 'Viewed src/example.ts' })).toBeChecked();
  await expect(page.getByText('1 of 1 viewed')).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.getItem('pr-review:viewed:143'))).toBe('{"src/example.ts":"file-sha"}');
  await expect(page.getByText('new line')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show file src/example.ts' }).click();
  await expect(page.getByText('new line')).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: 'Files changed' }).click();
  await expect(page.getByRole('checkbox', { name: 'Viewed src/example.ts' })).toBeChecked();
  await expect(page.getByText('new line')).toHaveCount(0);
  await expect(page.getByText('Fetch dev')).toHaveCount(0);
});

test('filters PRs and shows conversation and inline comments', async ({ page }) => {
  const items = [
    { number: 143, title: 'Review example', state: 'OPEN', isDraft: false,
      headRefName: 'feature/review', baseRefName: 'dev', updatedAt: '2026-10-16T04:00:00Z',
      url: 'https://github.com/owner/repo/pull/143', reviewDecision: 'APPROVED', checkStatus: 'success' },
    { number: 142, title: 'Older change', state: 'MERGED', isDraft: false,
      headRefName: 'feature/older', baseRefName: 'dev', updatedAt: '2026-10-15T04:00:00Z',
      url: 'https://github.com/owner/repo/pull/142', reviewDecision: null, checkStatus: 'none' },
  ];
  await page.route('**/api/prs?state=*', (route) => {
    const state = new URL(route.request().url()).searchParams.get('state');
    return route.fulfill({ json: { items: state === 'all' ? items : items.filter((pr) => pr.state.toLowerCase() === state) } });
  });
  await page.route('**/api/prs/143', (route) => route.fulfill({ json: {
    pr: { ...items[0], body: 'Ready for review', checks: [] },
    comments: [
      { kind: 'conversation', author: 'reviewer', body: 'Please check the API shape',
        createdAt: '2026-10-16T04:01:00Z', url: 'https://github.com/owner/repo/pull/143#issuecomment-1' },
      { kind: 'inline', author: 'reviewer', body: 'This line needs a test',
        createdAt: '2026-10-16T04:02:00Z', url: 'https://github.com/owner/repo/pull/143#discussion_r1',
        path: 'src/example.ts', line: 4 },
    ],
  } }));
  await page.route('**/api/prs/142', (route) => route.fulfill({ json: {
    pr: { ...items[1], body: '', checks: [] }, comments: [],
  } }));

  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'PR #143 Review example' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'PR #142 Older change' })).toHaveCount(0);
  await expect(page.getByText('Please check the API shape')).toBeVisible();
  await expect(page.getByText('This line needs a test')).toBeVisible();
  await page.getByRole('button', { name: 'Merged', exact: true }).click();
  await expect(page.getByRole('button', { name: 'PR #142 Older change' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'PR #143 Review example' })).toHaveCount(0);
});

test('confirms merge for an existing PR', async ({ page }) => {
  const item = { number: 143, title: 'Ready to merge', state: 'OPEN', isDraft: false,
    headRefName: 'feature/review', baseRefName: 'dev', updatedAt: '',
    url: 'https://github.com/PaulSklarXfit/psxfit365-monorepo/pull/143',
    reviewDecision: 'APPROVED', checkStatus: 'success' };
  let mergeBody: unknown;
  await page.route('**/api/prs?state=*', (route) => route.fulfill({ json: {
    items: new URL(route.request().url()).searchParams.get('state') === 'merged' ? [] : [item],
  } }));
  await page.route('**/api/prs/143', (route) => route.fulfill({ json: {
    pr: { ...item, headRefOid: headSha, body: '', checks: [] }, comments: [],
  } }));
  await page.route('**/api/session', (route) => route.fulfill({ json: { csrfToken: 'test-csrf' } }));
  await page.route('**/api/prs/143/merge', (route) => {
    mergeBody = route.request().postDataJSON();
    return route.fulfill({ json: { number: 143 } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Merge pull request' })).toBeVisible();
  expect(mergeBody).toBeUndefined();
  await page.getByRole('button', { name: 'Confirm merge' }).click();
  await expect(page.getByText('PR #143 merged.')).toBeVisible();
  expect(mergeBody).toEqual({ expectedHeadSha: headSha });
});
