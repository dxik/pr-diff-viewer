// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import App from "../../src/App";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("PR review app", () => {
  it("shows only PRs from the fixed repository without local branch or creation controls", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    expect(screen.getByText("PaulSklarXfit/psxfit365-monorepo")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Pull requests" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New pull request/i })).toBeNull();
    expect(screen.queryByText(/Current branch:/i)).toBeNull();
    expect(await screen.findByText("No pull requests found.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/prs?state=open", undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("navigates between pull requests and all workflows", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => ({ ok: true, json: async () => {
      const path = String(input);
      if (path === "/api/actions/workflows") return { workflows: [] };
      if (path.startsWith("/api/actions/runs")) return { runs: [], totalCount: 0 };
      return { items: [] };
    } })));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(await screen.findByText("No workflow runs found.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actions" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Pull requests" }));
    expect(await screen.findByText("No pull requests found.")).toBeTruthy();
  });
});
