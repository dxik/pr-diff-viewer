# PR Diff Viewer

Local GitHub pull request viewer for reviewing commits, comments, checks, and file diffs. It can also create and merge pull requests using the GitHub account authenticated in `gh`.

## Requirements

- Node.js 24 and pnpm 10
- Git and GitHub CLI (`gh`)
- GitHub access to the target repository (`gh auth login`)

The app binds to `127.0.0.1`. Each person runs their own copy and uses their own GitHub permissions.

## Install and run

Clone this app and install its dependencies:

```sh
git clone https://github.com/dxik/pr-diff-viewer.git
cd pr-diff-viewer
pnpm install --frozen-lockfile
gh auth login
```

Run the app:

```sh
pnpm dev
```

The default target is `PaulSklarXfit/psxfit365-monorepo`. To use another repository, set `PR_REVIEW_REPO=owner/repo` (or `$env:PR_REVIEW_REPO = "owner/repo"` in PowerShell) before starting. No local checkout is required to browse, review, create a PR from a GitHub branch, or merge.

To push and create a PR from the current local checkout, set `PR_REVIEW_REPO_ROOT` to its absolute path. For macOS or Linux:

```sh
PR_REVIEW_REPO_ROOT="$HOME/code/psxfit365-monorepo" pnpm dev
```

For Windows PowerShell:

```powershell
$env:PR_REVIEW_REPO_ROOT = "C:\code\psxfit365-monorepo"
pnpm dev
```

Open <http://127.0.0.1:4317>. The API runs on `127.0.0.1:4318`.

For a local production build, run `pnpm build` followed by `pnpm start`, then open <http://127.0.0.1:4318>.

The current pull request creation flow targets the `dev` branch. Merge follows GitHub's repository rules and requires the authenticated user to have merge permission.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
