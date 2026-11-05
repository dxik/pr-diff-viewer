# PR Diff Viewer

Local pull request viewer for `PaulSklarXfit/psxfit365-monorepo`. Browse reviews, conversation and inline comments, checks, commits, and code diffs. Users with GitHub permission can create or merge a PR after confirming it.

## Requirements

- Node.js 24 and pnpm 10
- GitHub CLI (`gh`) authenticated with access to `PaulSklarXfit/psxfit365-monorepo`

Each person runs the app locally using their own GitHub account. No checkout of the target repository is required. macOS, Linux, and Windows are supported when Node, pnpm, and `gh` are available.

## Install and run

```sh
git clone https://github.com/dxik/pr-diff-viewer.git
cd pr-diff-viewer
pnpm install --frozen-lockfile
gh auth login
pnpm dev
```

Open <http://127.0.0.1:4317>. The API runs on `127.0.0.1:4318`. For a local production build, run `pnpm build` followed by `pnpm start`, then open <http://127.0.0.1:4318>.

The app works with the fixed repository and offers the merge methods enabled in GitHub: merge commit, squash, or rebase. It shows merge conflicts when GitHub reports them and disables merge for a conflicting PR. To create a PR, compare two GitHub branches, review their commits and changes, then enter a title and optional description. No local branch or checkout is used. GitHub's comparison API returns up to 300 changed files, and the app warns if more may exist.

In the Conversation tab, users with permission can manage reviewers, assignees, labels, projects, milestones, and draft status. GitHub Projects requires project access; if the account lacks the required scope, run `gh auth refresh -s project` and restart the app.

The Actions tab lists workflows and their recent runs, with workflow filtering and pagination. Opening a run shows its details on GitHub and requires the account to have access to Actions in the repository.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
