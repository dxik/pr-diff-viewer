import { useEffect, useState, type FormEvent } from "react";

type Branch = { name: string; sha: string };
type Comparison = {
  base: Branch; head: Branch; existingPr: { number: number; title: string } | null; aheadBy: number; behindBy: number; totalCommits: number; filesLimited: boolean;
  commits: { sha: string; subject: string; author: string; authoredAt: string }[];
  files: { path: string; oldPath?: string; status: string; additions: number; deletions: number; patchAvailable: boolean; hunks: { header: string; lines: { kind: "add" | "remove" | "context" | "meta"; oldNumber: number | null; newNumber: number | null; content: string }[] }[] }[];
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const data: unknown = await response.json();
  if (!response.ok) throw new Error((data as { error?: string; message?: string }).error ?? (data as { message?: string }).message ?? `Request failed (${response.status})`);
  return data as T;
}

export default function CompareBrowser({ onCancel, onCreated }: { onCancel: () => void; onCreated: (number: number) => void }) {
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [branchError, setBranchError] = useState("");
  const [compareError, setCompareError] = useState("");
  const [createError, setCreateError] = useState("");
  const [branchVersion, setBranchVersion] = useState(0);
  const [compareVersion, setCompareVersion] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    let current = true;
    setBranchError("");
    request<{ branches: Branch[] }>("/api/compare/branches").then((result) => {
      if (!current) return;
      setBranches(result.branches);
      const initial = result.branches.find((branch) => branch.name === "dev")?.name ?? result.branches[0]?.name ?? "";
      setBase(initial);
      setHead(initial);
    }).catch((error: Error) => { if (current) setBranchError(error.message); });
    return () => { current = false; };
  }, [branchVersion]);

  useEffect(() => {
    let current = true;
    setComparison(null);
    setCompareError("");
    setShowForm(false);
    setCreateError("");
    if (!base || !head || base === head) return;
    const query = new URLSearchParams({ base, head });
    request<Comparison>(`/api/compare?${query}`).then((result) => { if (current) setComparison(result); })
      .catch((error: Error) => { if (current) setCompareError(error.message); });
    return () => { current = false; };
  }, [base, head, compareVersion]);

  const current = comparison?.base.name === base && comparison.head.name === head ? comparison : null;
  async function createPr(event: FormEvent) {
    event.preventDefault();
    if (!current || current.aheadBy === 0 || current.existingPr || isCreating) return;
    setIsCreating(true);
    setCreateError("");
    try {
      const { csrfToken } = await request<{ csrfToken: string }>("/api/session");
      const result = await request<{ number: number }>("/api/compare/pr", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ base, head, title: title.trim(), body, draft, expectedBaseSha: current.base.sha, expectedHeadSha: current.head.sha }) });
      onCreated(result.number);
    } catch (error) { setCreateError((error as Error).message); }
    finally { setIsCreating(false); }
  }

  return <section className="compare-page" aria-label="Compare changes">
    <div className="section-heading"><div><span className="eyebrow">GITHUB BRANCHES</span><h2>Compare changes</h2></div><button type="button" className="button button-secondary" disabled={isCreating} onClick={onCancel}>Back to pull requests</button></div>
    <p className="muted">Choose a base and compare branch to review changes before opening a pull request.</p>
    {branchError ? <div role="alert" className="alert alert-error">{branchError} <button type="button" onClick={() => setBranchVersion((value) => value + 1)}>Retry</button></div> : branches === null ? <p className="pr-message">Loading branches...</p> : branches.length === 0 ? <p className="pr-message">No branches found.</p> : <>
      <div className="compare-branches">
        <label>Base <select aria-label="Base branch" value={base} disabled={isCreating} onChange={(event) => setBase(event.target.value)}>{branches.map((branch) => <option value={branch.name} key={branch.name}>{branch.name}</option>)}</select></label>
        <span aria-hidden="true">&larr;</span>
        <label>Compare <select aria-label="Compare branch" value={head} disabled={isCreating} onChange={(event) => setHead(event.target.value)}>{branches.map((branch) => <option value={branch.name} key={branch.name}>{branch.name}</option>)}</select></label>
        {base !== head ? <button type="button" className="button button-secondary" disabled={isCreating} onClick={() => setCompareVersion((value) => value + 1)}>Refresh comparison</button> : null}
      </div>
      {base === head ? <p className="compare-notice">Choose different branches to compare changes.</p> : compareError ? <p role="alert" className="alert alert-error">{compareError}</p> : !current ? <p className="pr-message">Comparing branches...</p> : <>
        <div className="compare-summary"><div><strong>{current.existingPr ? <>An open pull request already exists: <a href={`https://github.com/PaulSklarXfit/psxfit365-monorepo/pull/${current.existingPr.number}`} target="_blank" rel="noopener noreferrer">#{current.existingPr.number} {current.existingPr.title}</a></> : current.aheadBy > 0 ? "Changes available for a pull request" : "No commits to merge"}</strong><p>{current.aheadBy} ahead, {current.behindBy} behind &middot; {current.totalCommits} commits &middot; {current.files.length}{current.filesLimited ? "+" : ""} files</p></div><button type="button" className="button button-primary" disabled={current.aheadBy === 0 || !!current.existingPr || isCreating} onClick={() => setShowForm(true)}>Create pull request</button></div>
        {showForm ? <form className="compare-create-form" onSubmit={(event) => void createPr(event)}><h3>Open a pull request</h3><p>From <strong>{head}</strong> into <strong>{base}</strong></p><label htmlFor="new-pr-title">Title</label><input id="new-pr-title" required maxLength={256} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Summarize your changes" /><label htmlFor="new-pr-body">Description</label><textarea id="new-pr-body" rows={6} maxLength={65000} value={body} onChange={(event) => setBody(event.target.value)} /><label className="checkbox-label"><input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} />Create as draft</label>{createError ? <p role="alert" className="alert alert-error">{createError}</p> : null}<div className="modal-actions"><button type="button" className="button button-secondary" disabled={isCreating} onClick={() => setShowForm(false)}>Cancel</button><button type="submit" className="button button-primary" disabled={isCreating || !title.trim()}>{isCreating ? "Creating..." : "Confirm create pull request"}</button></div></form> : null}
        <h3>Commits <span className="count-badge">{current.totalCommits}</span></h3>
        {current.commits.length ? <ol className="pr-commit-list">{current.commits.map((commit) => <li key={commit.sha}><code>{commit.sha.slice(0, 8)}</code><strong>{commit.subject}</strong><span>{commit.author}</span><time dateTime={commit.authoredAt}>{commit.authoredAt ? new Date(commit.authoredAt).toLocaleString() : ""}</time></li>)}</ol> : <p className="muted">No commits to compare.</p>}
        <h3>Files changed <span className="count-badge">{current.files.length}{current.filesLimited ? "+" : ""}</span></h3>
        {current.filesLimited ? <p className="muted">GitHub returns at most 300 files for a comparison. Additional files may not be shown.</p> : null}
        {current.files.length ? <div className="pr-files">{current.files.map((file) => <article className="pr-file" key={file.path}><div className="pr-file-heading"><strong>{file.path}</strong><span>{file.status}</span><span className="additions">+{file.additions}</span><span className="deletions">-{file.deletions}</span></div>{file.oldPath ? <p className="muted">Renamed from {file.oldPath}</p> : null}{!file.patchAvailable ? <p className="pr-message">GitHub has no text patch for this file (binary or too large).</p> : file.hunks.map((hunk, index) => <div className="hunk" key={`${hunk.header}-${index}`}><div className="hunk-header">{hunk.header}</div>{hunk.lines.map((line, lineIndex) => <div className={`diff-line line-${line.kind}`} key={lineIndex}><span className="line-number">{line.oldNumber ?? ""}</span><span className="line-number">{line.newNumber ?? ""}</span><span className="line-content"><span className="line-prefix">{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}</span>{line.content}</span></div>)}</div>)}</article>)}</div> : <p className="muted">No files changed.</p>}
      </>}
    </>}
  </section>;
}
