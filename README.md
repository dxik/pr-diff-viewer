# PR Diff Viewer

Local viewer for existing pull requests in `PaulSklarXfit/psxfit365-monorepo`. Browse reviews, conversation and inline comments, checks, commits, and code diffs. Users with GitHub merge permission can merge a PR after confirming it.

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

The app only reads PRs from the fixed repository and offers the merge methods enabled in GitHub: merge commit, squash, or rebase. It shows merge conflicts when GitHub reports them and disables merge for a conflicting PR. It does not create PRs or use the current local branch.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
