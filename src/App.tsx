import { useCallback, useEffect, useState, type FormEvent } from "react";
import PullRequestBrowser from "./PullRequestBrowser";
import "./styles.css";

type Summary = {
  branch: string;
  headSha: string;
  pr: { number: number } | null;
  csrfToken: string;
};

type PushStatus = {
  needsPush: boolean;
  branch: string;
  headSha: string;
  remoteSha: string | null;
};

type RemoteBranch = { name: string; sha: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const result: unknown = await response.json();
  if (!response.ok) {
    const failure = result as { error?: string; message?: string };
    throw new Error(failure.message || failure.error || `Request failed (${response.status})`);
  }
  return result as T;
}

function post(path: string, csrfToken: string, body?: object): Promise<unknown> {
  return request(path, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

export default function App() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [source, setSource] = useState<"local" | "remote">("remote");
  const [remoteBranches, setRemoteBranches] = useState<RemoteBranch[] | null>(null);
  const [branchLoadFailed, setBranchLoadFailed] = useState(false);
  const [branchLoadVersion, setBranchLoadVersion] = useState(0);
  const [headBranch, setHeadBranch] = useState("");
  const [sessionCsrfToken, setSessionCsrfToken] = useState("");
  const [browserVersion, setBrowserVersion] = useState(0);
  const [pushStatus, setPushStatus] = useState<PushStatus | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);

  const refreshSummary = useCallback(async () => {
    const nextSummary = await request<Summary>("/api/summary");
    setSummary(nextSummary);
    return nextSummary;
  }, []);

  useEffect(() => {
    refreshSummary().catch((failure: unknown) => setError((failure as Error).message));
  }, [refreshSummary]);

  useEffect(() => {
    if (!showCreateForm || source !== "remote") return;
    let isCurrent = true;
    request<{ branches: RemoteBranch[] }>("/api/branches")
      .then(({ branches }) => { if (isCurrent) { setRemoteBranches(branches.filter((branch) => branch.name !== "dev")); setBranchLoadFailed(false); } })
      .catch((failure: unknown) => { if (isCurrent) { setBranchLoadFailed(true); setError((failure as Error).message); } });
    if (!summary) {
      request<{ csrfToken: string }>("/api/session")
        .then(({ csrfToken }) => { if (isCurrent) setSessionCsrfToken(csrfToken); })
        .catch((failure: unknown) => { if (isCurrent) setError((failure as Error).message); });
    }
    return () => { isCurrent = false; };
  }, [showCreateForm, source, summary, branchLoadVersion]);

  function openCreateForm() {
    setError("");
    setRemoteBranches(null);
    setBranchLoadFailed(false);
    setHeadBranch("");
    setSource(summary?.branch && !summary.pr ? "local" : "remote");
    setShowCreateForm(true);
  }

  async function createPullRequest(currentSummary: Summary) {
    const created = (await post("/api/pr", currentSummary.csrfToken, {
      title: title.trim(), body, draft, expectedHeadSha: currentSummary.headSha,
    })) as { url?: string };
    await refreshSummary();
    setShowCreateForm(false);
    setPushStatus(null);
    setNotice(created.url ? `PR created: ${created.url}` : "PR created.");
    setBrowserVersion((version) => version + 1);
  }

  async function createRemotePullRequest(event: FormEvent) {
    event.preventDefault();
    const csrfToken = summary?.csrfToken ?? sessionCsrfToken;
    if (!csrfToken || !headBranch) return;
    setIsBusy(true);
    setError("");
    try {
      const created = (await post("/api/pr/remote", csrfToken, {
        headBranch, title: title.trim(), body, draft,
      })) as { url?: string };
      setShowCreateForm(false);
      setNotice(created.url ? `PR created: ${created.url}` : "PR created.");
      setBrowserVersion((version) => version + 1);
      if (summary?.branch === headBranch) void refreshSummary().catch((failure: unknown) => setError((failure as Error).message));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setIsBusy(false);
    }
  }

  async function checkPushStatus(event: FormEvent) {
    event.preventDefault();
    if (!summary?.branch) return;
    setIsBusy(true);
    setError("");
    try {
      const status = await request<PushStatus>("/api/push-status");
      if (status.headSha !== summary.headSha || status.branch !== summary.branch) {
        await refreshSummary();
        throw new Error("The branch changed. Review the latest commit before creating a PR.");
      }
      if (status.needsPush) setPushStatus(status);
      else await createPullRequest(summary);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setIsBusy(false);
    }
  }

  async function pushAndCreate() {
    if (!summary?.branch || !pushStatus) return;
    setIsBusy(true);
    setError("");
    try {
      await post("/api/push", summary.csrfToken, { expectedHeadSha: pushStatus.headSha });
      setPushStatus(null);
      await createPullRequest(summary);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">&lt;/&gt;</span><span>PR<span className="brand-light">Review</span></span></div>
        <span className="local-badge"><span className="online-dot" /> GitHub via gh</span>
      </header>
      <main className="workspace">
        <section className="intro pr-page-intro">
          <div>
            <div className="eyebrow">PULL REQUESTS</div>
            <h1>Pull requests</h1>
            <p>Browse reviews, commits, comments, and code changes from GitHub.</p>
          </div>
          <button className="button button-primary" onClick={openCreateForm}>
            New pull request
          </button>
        </section>
        {summary?.branch ? <div className="current-branch">Current branch: <strong>{summary.branch}</strong>{summary.pr ? <span> · PR #{summary.pr.number}</span> : null}</div> : null}
        {error && !showCreateForm ? <div className="alert alert-error" role="alert">{error}<button onClick={() => setError("")} aria-label="Dismiss error">×</button></div> : null}
        {notice ? <div className="alert alert-success" role="status">{notice}<button onClick={() => setNotice("")} aria-label="Dismiss notice">×</button></div> : null}
        <PullRequestBrowser key={browserVersion} currentPrNumber={summary?.pr?.number ?? null} onMerged={() => { void refreshSummary().catch((failure: unknown) => setError((failure as Error).message)); }} />
      </main>
      {showCreateForm ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="create-heading">
            <button className="modal-close" onClick={() => { setShowCreateForm(false); setPushStatus(null); }} aria-label="Close">×</button>
            {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
            {pushStatus ? (
              <>
                <span className="eyebrow">CONFIRM PUSH</span>
                <h2 id="create-heading">Push branch and create PR?</h2>
                <p>These commits will be pushed to GitHub before the PR is created.</p>
                <div className="push-details">
                  <span>Branch</span><strong>{pushStatus.branch}</strong>
                  <span>Commit</span><strong className="mono">{pushStatus.headSha}</strong>
                </div>
                <div className="modal-actions">
                  <button className="button button-secondary" onClick={() => setPushStatus(null)} disabled={isBusy}>Back</button>
                  <button className="button button-primary" onClick={pushAndCreate} disabled={isBusy}>{isBusy ? "Working…" : "Push and create PR"}</button>
                </div>
              </>
            ) : (
              <>
                <span className="eyebrow">NEW PULL REQUEST</span>
                <h2 id="create-heading">Create pull request</h2>
                <p>Open a pull request into <strong>dev</strong>.</p>
                {summary?.branch && !summary.pr ? <div className="source-options" aria-label="Head source">
                  <button type="button" className={source === "local" ? "active" : ""} aria-pressed={source === "local"} onClick={() => { setSource("local"); setError(""); }}>Current checkout</button>
                  <button type="button" className={source === "remote" ? "active" : ""} aria-pressed={source === "remote"} onClick={() => { setSource("remote"); setError(""); }}>GitHub branch</button>
                </div> : null}
                <form onSubmit={source === "local" ? checkPushStatus : createRemotePullRequest}>
                  {source === "remote" ? <><label htmlFor="head-branch">Head branch</label>
                    <select id="head-branch" value={headBranch} onChange={(event) => setHeadBranch(event.target.value)} required>
                      <option value="">{branchLoadFailed ? "Could not load branches" : remoteBranches === null ? "Loading branches…" : "Select a branch"}</option>
                      {remoteBranches?.map((branch) => <option value={branch.name} key={branch.name}>{branch.name}</option>)}
                    </select>
                    {branchLoadFailed ? <button type="button" className="button button-secondary retry-branches" onClick={() => { setError(""); setRemoteBranches(null); setBranchLoadFailed(false); setBranchLoadVersion((version) => version + 1); }}>Retry branches</button> : null}
                    {remoteBranches?.length === 0 ? <p>No GitHub branches available for a PR into dev.</p> : null}
                  </> : <p>From <strong>{summary?.branch}</strong>. If needed, you will confirm the push before creating the PR.</p>}
                  <label htmlFor="pr-title">Title</label>
                  <input id="pr-title" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={256} placeholder="Summarize your changes" />
                  <label htmlFor="pr-body">Description</label>
                  <textarea id="pr-body" value={body} onChange={(event) => setBody(event.target.value)} rows={6} placeholder="What changed, and why?" />
                  <label className="checkbox-label"><input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} />Create as draft</label>
                  <div className="modal-actions">
                    <button type="button" className="button button-secondary" onClick={() => setShowCreateForm(false)}>Cancel</button>
                    <button type="submit" className="button button-primary" disabled={isBusy || (source === "remote" && (!headBranch || !(summary?.csrfToken ?? sessionCsrfToken)))}>{isBusy ? "Working…" : source === "local" ? "Continue" : "Create pull request"}</button>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
