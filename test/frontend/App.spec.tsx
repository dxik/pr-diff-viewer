// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../../src/App";

const summary = { branch: "feature/review", headSha: "a".repeat(40), pr: null, csrfToken: "csrf-test" };

function mockApi(responses: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const value = responses[key] ?? (key === "GET /api/prs?state=open" ? { items: [] } : undefined);
    if (value instanceof Error) return { ok: false, status: 500, json: async () => ({ error: value.message }) };
    return { ok: true, json: async () => value };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("PR review", () => {
  it("shows GitHub PRs even when the local branch is unavailable", async () => {
    mockApi({
      "GET /api/summary": new Error("Local branch unavailable"),
      "GET /api/prs?state=open": { items: [{ number: 143, title: "Review", state: "OPEN", isDraft: false, headRefName: "feature", baseRefName: "dev", updatedAt: "", url: "https://github.com/o/r/pull/143", reviewDecision: null, checkStatus: "none" }] },
      "GET /api/prs/143": { pr: { number: 143, title: "Review", state: "OPEN", isDraft: false, headRefName: "feature", baseRefName: "dev", updatedAt: "", url: "https://github.com/o/r/pull/143", reviewDecision: null, checkStatus: "none", body: "", checks: [] }, comments: [] },
    });
    render(<App />);
    expect(await screen.findByRole("button", { name: /PR #143 Review/i })).toBeTruthy();
    expect(screen.getByText("Local branch unavailable")).toBeTruthy();
    expect(screen.queryByText("Review your changes")).toBeNull();
  });

  it("allows creating a PR without reading the local dev ref", async () => {
    mockApi({ "GET /api/summary": summary });
    render(<App />);
    expect(await screen.findByText("feature/review")).toBeTruthy();
    expect(screen.getByRole("button", { name: /New pull request/i })).toBeEnabled();
  });

  it("creates a PR from a GitHub branch even when the checkout already has a PR", async () => {
    const fetchMock = mockApi({
      "GET /api/summary": { ...summary, pr: { number: 143 } },
      "GET /api/session": { csrfToken: "csrf-test" },
      "GET /api/branches": { branches: [{ name: "dev", sha: "a".repeat(40) }, { name: "feature/next", sha: "b".repeat(40) }] },
      "POST /api/pr/remote": { url: "https://github.com/o/r/pull/144" },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /New pull request/i }));
    fireEvent.change(await screen.findByLabelText("Head branch"), { target: { value: "feature/next" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Next feature" } });
    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/pr/remote", expect.objectContaining({
      method: "POST", body: JSON.stringify({ headBranch: "feature/next", title: "Next feature", body: "", draft: false }),
    })));
    expect(fetchMock).not.toHaveBeenCalledWith("/api/push", expect.anything());
  });

  it("creates from GitHub when local branch information is unavailable", async () => {
    const fetchMock = mockApi({
      "GET /api/summary": new Error("Local branch unavailable"),
      "GET /api/session": { csrfToken: "session-csrf" },
      "GET /api/branches": { branches: [{ name: "feature/next", sha: "b".repeat(40) }] },
      "POST /api/pr/remote": { url: "https://github.com/o/r/pull/144" },
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /New pull request/i }));
    fireEvent.change(await screen.findByLabelText("Head branch"), { target: { value: "feature/next" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Next feature" } });
    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/pr/remote", expect.objectContaining({
      headers: expect.objectContaining({ "X-CSRF-Token": "session-csrf" }),
    })));
  });

  it("can retry loading GitHub branches after a network error", async () => {
    mockApi({
      "GET /api/summary": { ...summary, pr: { number: 143 } },
      "GET /api/branches": new Error("GitHub unavailable"),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /New pull request/i }));
    expect(await screen.findByText("GitHub unavailable")).toBeTruthy();
    mockApi({
      "GET /api/branches": { branches: [{ name: "feature/next", sha: "b".repeat(40) }] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry branches" }));
    expect(await screen.findByRole("option", { name: "feature/next" })).toBeTruthy();
  });

  it("confirms the branch and commit before pushing and creating a PR", async () => {
    const fetchMock = mockApi({
      "GET /api/summary": summary,
      "GET /api/push-status": { needsPush: true, branch: summary.branch, headSha: summary.headSha, remoteSha: null },
      "POST /api/push": { branch: summary.branch, headSha: summary.headSha, remoteSha: summary.headSha },
      "POST /api/pr": { url: "https://github.com/o/r/pull/144" },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /New pull request/i }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "My PR" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(summary.headSha)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/push", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Push and create PR" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/push", expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedHeadSha: summary.headSha }) })));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/pr", expect.objectContaining({ method: "POST", body: JSON.stringify({ title: "My PR", body: "", draft: false, expectedHeadSha: summary.headSha }) })));
  });

  it("creates a draft directly when the branch is already pushed", async () => {
    const fetchMock = mockApi({
      "GET /api/summary": summary,
      "GET /api/push-status": { needsPush: false, branch: summary.branch, headSha: summary.headSha, remoteSha: summary.headSha },
      "POST /api/pr": { url: "https://github.com/o/r/pull/144" },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /New pull request/i }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Draft PR" } });
    fireEvent.click(screen.getByLabelText("Create as draft"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/pr", expect.objectContaining({ body: JSON.stringify({ title: "Draft PR", body: "", draft: true, expectedHeadSha: summary.headSha }) })));
    expect(fetchMock).not.toHaveBeenCalledWith("/api/push", expect.anything());
  });
});
