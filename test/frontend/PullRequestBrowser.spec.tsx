// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PullRequestBrowser from "../../src/PullRequestBrowser";

const items = [
  { number: 143, title: "Improve training plan", state: "OPEN", isDraft: false, headRefName: "feature/plan", baseRefName: "dev", updatedAt: "2026-10-16T04:00:00Z", url: "https://github.com/psxfit365/repo/pull/143", reviewDecision: "APPROVED", checkStatus: "success" },
  { number: 142, title: "Work in progress", state: "OPEN", isDraft: true, headRefName: "feature/wip", baseRefName: "dev", updatedAt: "2026-10-15T04:00:00Z", url: "https://github.com/psxfit365/repo/pull/142", reviewDecision: null, checkStatus: "pending" },
  { number: 141, title: "Older work", state: "MERGED", isDraft: false, headRefName: "feature/old", baseRefName: "dev", updatedAt: "2026-10-14T04:00:00Z", url: "https://github.com/psxfit365/repo/pull/141", reviewDecision: null, checkStatus: "failure" },
];

function mockApi(responses: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    let response = responses[`${init?.method ?? "GET"} ${path}`] ?? responses[path];
    if (path === "/api/session" && response === undefined) response = { csrfToken: "test-csrf" };
    if (response === undefined && path.startsWith("/api/prs?state=")) {
      const source = responses["/api/prs"];
      if (source instanceof Error) response = source;
      else {
        const state = new URL(path, "http://localhost").searchParams.get("state");
        const sourceItems = (source as { items: typeof items }).items;
        response = { items: state === "all" ? sourceItems : sourceItems.filter((pr) => pr.state.toLowerCase() === state) };
      }
    }
    if (response instanceof Error) return { ok: false, status: 500, json: async () => ({ message: response.message }) };
    return { ok: true, json: async () => response };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => { cleanup(); window.localStorage.clear(); vi.unstubAllGlobals(); });

describe("pull request browser", () => {
  it("confirms merge and refreshes the merged PR list", async () => {
    const head = "a".repeat(40);
    const fetchMock = mockApi({
      "/api/prs": { items: [items[0], { ...items[0], state: "MERGED" }] },
      "/api/prs/143": { pr: { ...items[0], headRefOid: head, body: "", checks: [] }, comments: [] },
      "POST /api/prs/143/merge": { number: 143 },
    });
    render(<PullRequestBrowser />);
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    expect(screen.getByRole("dialog", { name: "Merge pull request" })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/prs/143/merge", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Confirm merge" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/prs/143/merge", expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedHeadSha: head }) })));
    expect(await screen.findByText("PR #143 merged.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Merged" })).toHaveAttribute("aria-pressed", "true");
  });

  it("does not offer merge for a draft or merged PR", async () => {
    mockApi({ "/api/prs": { items }, "/api/prs/142": { pr: { ...items[1], headRefOid: "a".repeat(40), body: "Draft body", checks: [] }, comments: [] }, "/api/prs/141": { pr: { ...items[2], headRefOid: "a".repeat(40), body: "Merged body", checks: [] }, comments: [] } });
    render(<PullRequestBrowser />);
    await screen.findByText("Draft");
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Merged" }));
    await screen.findByText("Merged body");
    expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
  });

  it("keeps the merge confirmation open when GitHub rejects it", async () => {
    const fetchMock = mockApi({
      "/api/prs": { items: [items[0]] },
      "/api/prs/143": { pr: { ...items[0], headRefOid: "a".repeat(40), body: "", checks: [] }, comments: [] },
      "POST /api/prs/143/merge": new Error("PR head changed"),
    });
    render(<PullRequestBrowser />);
    fireEvent.click(await screen.findByRole("button", { name: "Merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalledWith("/api/prs/143/merge", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm merge" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("PR head changed");
    expect(screen.getByRole("dialog", { name: "Merge pull request" })).toBeTruthy();
  });
  it("copies the selected PR URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    mockApi({
      "/api/prs": { items: items.slice(0, 2) },
      "/api/prs/143": { pr: { ...items[0], body: "", checks: [] }, comments: [] },
      "/api/prs/142": { pr: { ...items[1], body: "", checks: [] }, comments: [] },
    });
    render(<PullRequestBrowser />);

    fireEvent.click(await screen.findByRole("button", { name: "Copy PR URL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(items[0].url));
    expect(screen.getByRole("button", { name: "Copied PR URL" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open on GitHub/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /PR #142 Work in progress/i }));
    fireEvent.click(screen.getByRole("button", { name: /PR #143 Improve training plan/i }));
    expect(await screen.findByRole("button", { name: "Copy PR URL" })).toBeTruthy();
  });

  it("selects a PR and shows checks and plain text comments", async () => {
    mockApi({
      "/api/prs": { items },
      "/api/prs/142": { pr: { ...items[1], body: "Draft body", checks: [{ name: "build", status: "IN_PROGRESS", conclusion: null }] }, comments: [{ kind: "inline", author: "alice", body: "Please check this line", createdAt: "2026-10-15T05:00:00Z", url: "https://github.com/psxfit365/repo/pull/142#discussion_r1", path: "src/a.ts", line: 12 }] },
    });
    render(<PullRequestBrowser />);
    fireEvent.click(await screen.findByRole("button", { name: /PR #142 Work in progress/i }));
    expect(screen.getByRole("button", { name: /PR #142 Work in progress/i })).toHaveAttribute("aria-current", "true");
    expect(await screen.findByText("Please check this line")).toBeTruthy();
    expect(screen.getByText("src/a.ts:12")).toBeTruthy();
    expect(screen.getByText("Draft body")).toBeTruthy();
    expect(screen.getByText("IN_PROGRESS")).toBeTruthy();
  });

  it("filters PRs and fetches selected details", async () => {
    const fetchMock = mockApi({ "/api/prs": { items }, "/api/prs/143": { pr: { ...items[0], body: "Body", checks: [] }, comments: [] }, "/api/prs/141": { pr: { ...items[2], body: "Merged body", checks: [] }, comments: [] } });
    render(<PullRequestBrowser />);
    expect(await screen.findByRole("button", { name: /PR #143 Improve training plan/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toHaveAttribute("aria-pressed", "true");
    expect(fetchMock).toHaveBeenCalledWith("/api/prs?state=open", undefined);
    expect(screen.queryByRole("button", { name: /PR #141 Older work/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Merged" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/prs?state=merged", undefined));
    expect(screen.queryByRole("button", { name: /PR #143 Improve training plan/i })).toBeNull();
    expect(await screen.findByRole("button", { name: /PR #141 Older work/i })).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("button", { name: /PR #141 Older work/i }));
    expect(await screen.findByText("Merged body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(await screen.findByRole("button", { name: /PR #143 Improve training plan/i })).toBeTruthy();
  });

  it("starts with an open PR when the current branch PR is merged", async () => {
    mockApi({ "/api/prs": { items }, "/api/prs/143": { pr: { ...items[0], body: "Open body", checks: [] }, comments: [] } });
    render(<PullRequestBrowser />);
    expect(await screen.findByRole("button", { name: /PR #143 Improve training plan/i })).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("button", { name: /PR #141 Older work/i })).toBeNull();
  });

  it("shows no open PRs and lets the user browse merged PRs", async () => {
    mockApi({ "/api/prs": { items: [items[2]] }, "/api/prs/141": { pr: { ...items[2], body: "Merged body", checks: [] }, comments: [] } });
    render(<PullRequestBrowser />);
    expect(await screen.findByText("No pull requests found.")).toBeTruthy();
    expect(screen.getByText("Select a pull request to see its status and comments.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Merged" }));
    expect(await screen.findByText("Merged body")).toBeTruthy();
  });

  it("shows empty and error states", async () => {
    mockApi({ "/api/prs": { items: [] } });
    const view = render(<PullRequestBrowser />);
    expect(await screen.findByText("No pull requests found.")).toBeTruthy();
    view.unmount();
    mockApi({ "/api/prs": new Error("GitHub unavailable") });
    render(<PullRequestBrowser />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "GitHub unavailable");
  });

  it("does not link to an untrusted comment URL", async () => {
    mockApi({ "/api/prs": { items: [items[0]] }, "/api/prs/143": { pr: { ...items[0], body: "", checks: [] }, comments: [{ kind: "conversation", author: "bob", body: "Looks good", createdAt: "2026-10-16T05:00:00Z", url: "javascript:alert(1)" }] } });
    render(<PullRequestBrowser />);
    expect(await screen.findByText("Looks good")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /View comment/i })).toBeNull();
    await waitFor(() => expect(screen.getByText("No checks reported.")).toBeTruthy());
  });

  it("shows PR commits and GitHub file patches in separate tabs", async () => {
    window.localStorage.setItem("pr-review:viewed:143", JSON.stringify({ "assets/logo.png": "logo-sha" }));
    mockApi({
      "/api/prs": { items: [items[0]] },
      "/api/prs/143": { pr: { ...items[0], body: "Review body", checks: [] }, comments: [] },
      "/api/prs/143/commits": { commits: [{ sha: "a".repeat(40), subject: "Improve plan", author: "Alice", authoredAt: "2026-10-16T10:00:00Z" }] },
      "/api/prs/143/files": { files: [{
        path: "src/plan.ts", sha: "plan-sha", status: "modified", additions: 1, deletions: 1, isBinary: false, patchAvailable: true,
        hunks: [{ header: "@@ -1 +1 @@", lines: [
          { kind: "remove", oldNumber: 1, newNumber: null, content: "old" },
          { kind: "add", oldNumber: null, newNumber: 1, content: "new" },
        ] }],
      }, { path: "assets/logo.png", sha: "logo-sha", status: "added", additions: 0, deletions: 0, isBinary: true, patchAvailable: false, hunks: [] }] },
    });
    render(<PullRequestBrowser />);
    fireEvent.click(await screen.findByRole("tab", { name: "Commits" }));
    expect(await screen.findByText("Improve plan")).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Files changed" }));
    expect(await screen.findByRole("link", { name: "src/plan.ts" })).toBeTruthy();
    expect(screen.getByText("new")).toBeTruthy();
    expect(screen.getByRole("link", { name: "assets/logo.png" })).toBeTruthy();
    expect(screen.queryByText(/text patch/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Show file assets/logo.png" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "src/plan.ts" })).toHaveAttribute("href", "#pr-143-file-0");
    expect(screen.getByRole("link", { name: "assets/logo.png" })).toHaveAttribute("href", "#pr-143-file-1");
    expect(screen.getByRole("navigation", { name: "Changed files in PR" })).toBeTruthy();
    expect(screen.getByText("1 of 2 viewed")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Viewed src/plan.ts" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Viewed assets/logo.png" })).toBeChecked();
  });

  it("stores Viewed locally and collapses without a GitHub mutation", async () => {
    const fetchMock = mockApi({
      "/api/prs": { items: [items[0]] },
      "/api/prs/143": { pr: { ...items[0], body: "", checks: [] }, comments: [] },
      "/api/prs/143/files": { files: [{ path: "src/plan.ts", sha: "plan-sha", status: "modified", additions: 1, deletions: 0, isBinary: false, patchAvailable: true, hunks: [{ header: "@@ -0,0 +1 @@", lines: [{ kind: "add", oldNumber: null, newNumber: 1, content: "new content" }] }] }] },
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/prs?state=open") return { ok: true, json: async () => ({ items: [items[0]] }) };
      if (path === "/api/prs/143") return { ok: true, json: async () => ({ pr: { ...items[0], body: "", checks: [] }, comments: [] }) };
      return { ok: true, json: async () => ({ files: [{ path: "src/plan.ts", sha: "plan-sha", status: "modified", additions: 1, deletions: 0, isBinary: false, patchAvailable: true, hunks: [{ header: "@@ -0,0 +1 @@", lines: [{ kind: "add", oldNumber: null, newNumber: 1, content: "new content" }] }] }] }) };
    });
    render(<PullRequestBrowser />);
    fireEvent.click(await screen.findByRole("tab", { name: "Files changed" }));
    const viewed = await screen.findByRole("checkbox", { name: "Viewed src/plan.ts" });
    expect(screen.getByText("new content")).toBeTruthy();
    fireEvent.click(viewed);
    await waitFor(() => expect(viewed).toBeChecked());
    expect(screen.queryByText("new content")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem("pr-review:viewed:143") ?? "{}" )).toEqual({ "src/plan.ts": "plan-sha" });
    fireEvent.click(screen.getByRole("button", { name: "Show file src/plan.ts" }));
    expect(screen.getByText("new content")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide file src/plan.ts" }));
    expect(screen.queryByText("new content")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/prs/143/files/viewed", expect.anything());
    fireEvent.click(viewed);
    await waitFor(() => expect(viewed).not.toBeChecked());
    expect(screen.getByText("new content")).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem("pr-review:viewed:143") ?? "{}" )).toEqual({});
  });

  it("restores Viewed from localStorage after remount", async () => {
    const responses = {
      "/api/prs": { items: [items[0]] },
      "/api/prs/143": { pr: { ...items[0], body: "", checks: [] }, comments: [] },
      "/api/prs/143/files": { files: [{ path: "src/plan.ts", sha: "plan-sha", status: "modified", additions: 1, deletions: 0, isBinary: false, patchAvailable: true, hunks: [{ header: "@@ -0,0 +1 @@", lines: [{ kind: "add", oldNumber: null, newNumber: 1, content: "new content" }] }] }] },
    };
    mockApi(responses);
    const view = render(<PullRequestBrowser />);
    fireEvent.click(await screen.findByRole("tab", { name: "Files changed" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Viewed src/plan.ts" }));
    await waitFor(() => expect(screen.queryByText("new content")).toBeNull());
    view.unmount();
    render(<PullRequestBrowser />);
    fireEvent.click(await screen.findByRole("tab", { name: "Files changed" }));
    expect(await screen.findByRole("checkbox", { name: "Viewed src/plan.ts" })).toBeChecked();
    expect(screen.queryByText("new content")).toBeNull();
  });

  it("shows a changed file again when its GitHub SHA changes", async () => {
    window.localStorage.setItem("pr-review:viewed:143", JSON.stringify({ "src/plan.ts": "old-sha" }));
    mockApi({
      "/api/prs": { items: [items[0]] },
      "/api/prs/143": { pr: { ...items[0], body: "", checks: [] }, comments: [] },
      "/api/prs/143/files": { files: [{ path: "src/plan.ts", sha: "new-sha", status: "modified", additions: 1, deletions: 0, isBinary: false, patchAvailable: true, hunks: [{ header: "@@ -0,0 +1 @@", lines: [{ kind: "add", oldNumber: null, newNumber: 1, content: "updated line" }] }] }] },
    });
    render(<PullRequestBrowser />);
    fireEvent.click(await screen.findByRole("tab", { name: "Files changed" }));
    expect(await screen.findByText("updated line")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Viewed src/plan.ts" })).not.toBeChecked();
  });

  it("recovers from malformed local Viewed data", async () => {
    window.localStorage.setItem("pr-review:viewed:143", "{bad-json");
    mockApi({
      "/api/prs": { items: [items[0]] },
      "/api/prs/143": { pr: { ...items[0], body: "", checks: [] }, comments: [] },
      "/api/prs/143/files": { files: [{ path: "src/plan.ts", sha: "plan-sha", status: "modified", additions: 1, deletions: 0, isBinary: false, patchAvailable: true, hunks: [] }] },
    });
    render(<PullRequestBrowser />);
    fireEvent.click(await screen.findByRole("tab", { name: "Files changed" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Viewed src/plan.ts" }));
    expect(screen.getByRole("checkbox", { name: "Viewed src/plan.ts" })).toBeChecked();
    expect(JSON.parse(window.localStorage.getItem("pr-review:viewed:143") ?? "{}" )).toEqual({ "src/plan.ts": "plan-sha" });
  });
});
