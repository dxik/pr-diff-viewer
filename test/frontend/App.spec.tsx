// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
});
