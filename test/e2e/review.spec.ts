import { expect, test } from '@playwright/test';

const headSha = 'a'.repeat(40);
function summary(pr: object | null) {
  return {
    branch: 'feature/review', headSha, pr, csrfToken: 'test-csrf',
  };
}

test('shows PR commits and code changes from GitHub', async ({ page }) => {
  const pr = {
    number: 143, title: 'Review example', body: 'Ready for review',
    url: 'https://github.com/owner/repo/pull/143', state: 'OPEN', isDraft: false,
    reviewDecision: 'APPROVED', checks: [{ name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  };
  await page.route('**/api/summary', (route) => route.fulfill({ json: summary(pr) }));
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

test('requires push confirmation before creating a PR', async ({ page }) => {
  let created = false;
  let pushCount = 0;
  let createCount = 0;
  await page.route('**/api/summary', (route) => route.fulfill({
    json: summary(created ? {
      number: 144, title: 'My PR', body: 'What changed',
      url: 'https://github.com/owner/repo/pull/144', state: 'OPEN', isDraft: false,
      reviewDecision: null, checks: [],
    } : null),
  }));
  await page.route('**/api/prs?state=*', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/push-status', (route) => route.fulfill({
    json: { needsPush: true, branch: 'feature/review', headSha, remoteSha: null },
  }));
  await page.route('**/api/push', (route) => {
    pushCount += 1;
    return route.fulfill({ json: { branch: 'feature/review', headSha, remoteSha: headSha } });
  });
  await page.route('**/api/pr', (route) => {
    createCount += 1;
    created = true;
    return route.fulfill({ json: { url: 'https://github.com/owner/repo/pull/144' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /New pull request/ }).click();
  await page.getByLabel('Title').fill('My PR');
  await page.getByLabel('Description').fill('What changed');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Push branch and create PR?')).toBeVisible();
  expect(pushCount).toBe(0);
  expect(createCount).toBe(0);
  await page.getByRole('button', { name: 'Push and create PR' }).click();
  await expect(page.getByText('PR created: https://github.com/owner/repo/pull/144')).toBeVisible();
  expect(pushCount).toBe(1);
  expect(createCount).toBe(1);
});

test('creates a PR from a GitHub branch while the checkout already has a PR', async ({ page }) => {
  let pushCount = 0;
  let created: { headBranch: string; title: string; body: string; draft: boolean } | null = null;
  await page.route('**/api/summary', (route) => route.fulfill({ json: summary({ number: 143 }) }));
  await page.route('**/api/branches', (route) => route.fulfill({ json: { branches: [{ name: 'dev', sha: headSha }, { name: 'feature/next', sha: 'b'.repeat(40) }] } }));
  await page.route('**/api/prs?state=*', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/push', (route) => { pushCount += 1; return route.fulfill({ json: {} }); });
  await page.route('**/api/pr/remote', (route) => {
    created = route.request().postDataJSON() as typeof created;
    return route.fulfill({ json: { url: 'https://github.com/owner/repo/pull/144' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'New pull request' }).click();
  await page.getByLabel('Head branch').selectOption('feature/next');
  await page.getByLabel('Title').fill('Next feature');
  await page.getByLabel('Create as draft').check();
  await page.getByRole('button', { name: 'Create pull request' }).click();
  await expect(page.getByText('PR created: https://github.com/owner/repo/pull/144')).toBeVisible();
  expect(created).toEqual({ headBranch: 'feature/next', title: 'Next feature', body: '', draft: true });
  expect(pushCount).toBe(0);
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
  await page.route('**/api/summary', (route) => route.fulfill({ json: summary(null) }));
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
