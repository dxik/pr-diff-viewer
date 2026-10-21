import { useEffect, useState } from "react";

type PullRequestItem = {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  updatedAt: string;
  url: string;
  reviewDecision: string | null;
  checkStatus: "success" | "failure" | "pending" | "none";
};

type PullRequestDetail = PullRequestItem & {
  body: string;
  headRefOid: string;
  checks: { name: string; status: string; conclusion: string | null }[];
};

type PullRequestComment = {
    kind: "conversation" | "review" | "inline";
    author: string;
    body: string;
    createdAt: string;
    url: string;
    path?: string;
    line?: number | null;
};

type PrCommit = { sha: string; subject: string; author: string; authoredAt: string };
type PrFile = {
  path: string; sha: string; oldPath?: string; status: string; additions: number; deletions: number;
  patchAvailable: boolean; isBinary: boolean; viewed: boolean;
  hunks: { header: string; lines: { kind: "add" | "remove" | "context" | "meta"; oldNumber: number | null; newNumber: number | null; content: string }[] }[];
};
type GitHubFile = Omit<PrFile, "viewed">;
type DetailTab = "Conversation" | "Commits" | "Files changed";

type Filter = "All" | "Open" | "Merged" | "Closed";
const filters: Filter[] = ["All", "Open", "Merged", "Closed"];

function viewedStorageKey(number: number): string {
  return `pr-review:viewed:${number}`;
}

function readViewedState(number: number, files: { path: string; sha: string }[]): { markers: Record<string, string>; wasReset: boolean } {
  const stored = window.localStorage.getItem(viewedStorageKey(number));
  if (stored === null) return { markers: {}, wasReset: false };
  try {
    const parsed: unknown = JSON.parse(stored);
    if (Array.isArray(parsed) && parsed.every((path) => typeof path === "string")) {
      const oldPaths = new Set(parsed as string[]);
      const markers = Object.fromEntries(files.filter((file) => oldPaths.has(file.path)).map((file) => [file.path, file.sha]));
      window.localStorage.setItem(viewedStorageKey(number), JSON.stringify(markers));
      return { markers, wasReset: false };
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.values(parsed).every((sha) => typeof sha === "string")) {
      return { markers: parsed as Record<string, string>, wasReset: false };
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  window.localStorage.removeItem(viewedStorageKey(number));
  return { markers: {}, wasReset: true };
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const result: unknown = await response.json();
  if (!response.ok) {
    const failure = result as { message?: string; error?: string };
    throw new Error(failure.message || failure.error || `Request failed (${response.status})`);
  }
  return result as T;
}

function githubUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "github.com" ? url : undefined;
  } catch {
    return undefined;
  }
}

function stateLabel(pr: PullRequestItem): string {
  return pr.isDraft && pr.state === "OPEN" ? "Draft" : pr.state.toLowerCase();
}

export default function PullRequestBrowser() {
  const [items, setItems] = useState<PullRequestItem[] | null>(null);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [detail, setDetail] = useState<PullRequestDetail | null>(null);
  const [comments, setComments] = useState<PullRequestComment[]>([]);
  const [filter, setFilter] = useState<Filter>("Open");
  const [tab, setTab] = useState<DetailTab>("Conversation");
  const [commits, setCommits] = useState<{ number: number; items: PrCommit[] } | null>(null);
  const [files, setFiles] = useState<{ number: number; items: PrFile[] } | null>(null);
  const [tabError, setTabError] = useState("");
  const [viewedError, setViewedError] = useState<{ number: number | null; message: string } | null>(null);
  const [expandedViewedFiles, setExpandedViewedFiles] = useState<Set<string>>(() => new Set());
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [copyStatus, setCopyStatus] = useState<{ number: number; result: "copied" | "failed" } | null>(null);
  const [mergeTarget, setMergeTarget] = useState<PullRequestDetail | null>(null);
  const [mergeError, setMergeError] = useState("");
  const [mergeNotice, setMergeNotice] = useState("");
  const [isMerging, setIsMerging] = useState(false);
  const [listVersion, setListVersion] = useState(0);

  useEffect(() => {
    let isCurrent = true;
    setItems(null);
    setSelectedNumber(null);
    setListError("");
    getJson<{ items: PullRequestItem[] }>(`/api/prs?state=${filter.toLowerCase()}`)
      .then(({ items: nextItems }) => {
        if (!isCurrent) return;
        setItems(nextItems);
        setSelectedNumber(nextItems[0]?.number ?? null);
      })
      .catch((failure: unknown) => { if (isCurrent) setListError((failure as Error).message); });
    return () => { isCurrent = false; };
  }, [filter, listVersion]);

  useEffect(() => {
    if (selectedNumber === null) return;
    let isCurrent = true;
    setDetail(null);
    setComments([]);
    setDetailError("");
    getJson<{ pr: PullRequestDetail; comments: PullRequestComment[] }>(`/api/prs/${selectedNumber}`)
      .then(({ pr, comments: nextComments }) => { if (isCurrent) { setDetail(pr); setComments(nextComments); } })
      .catch((failure: unknown) => { if (isCurrent) setDetailError((failure as Error).message); });
    return () => { isCurrent = false; };
  }, [selectedNumber]);

  useEffect(() => {
    if (selectedNumber === null || tab === "Conversation") return;
    let isCurrent = true;
    setTabError("");
    const path = tab === "Commits" ? "commits" : "files";
    getJson<{ commits?: PrCommit[]; files?: GitHubFile[] }>(`/api/prs/${selectedNumber}/${path}`)
      .then((result) => {
        if (!isCurrent) return;
        if (tab === "Commits") setCommits({ number: selectedNumber, items: result.commits ?? [] });
        else {
          let markers: Record<string, string> = {};
          try {
            const state = readViewedState(selectedNumber, result.files ?? []);
            markers = state.markers;
            if (state.wasReset) setViewedError({ number: selectedNumber, message: "Invalid local Viewed data was reset." });
          }
          catch { setViewedError({ number: selectedNumber, message: "Could not read Viewed from this browser." }); }
          setFiles({ number: selectedNumber, items: (result.files ?? []).map((file) => ({ ...file, viewed: markers[file.path] === file.sha })) });
        }
      })
      .catch((failure: unknown) => { if (isCurrent) setTabError((failure as Error).message); });
    return () => { isCurrent = false; };
  }, [selectedNumber, tab]);

  const visibleItems = items ?? [];
  const selectedItem = items?.find((pr) => pr.number === selectedNumber);
  let copyButtonText = "Copy PR URL";
  if (copyStatus?.number === selectedNumber) {
    copyButtonText = copyStatus.result === "copied" ? "Copied PR URL" : "Could not copy URL";
  }

  function selectFilter(option: Filter) {
    setFilter(option);
    setTab("Conversation");
    setMergeTarget(null);
  }

  function selectPr(number: number) {
    setSelectedNumber(number);
    setTab("Conversation");
    setViewedError(null);
    setCopyStatus(null);
    setMergeTarget(null);
  }

  async function copyPrUrl(number: number, url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus({ number, result: "copied" });
    } catch {
      setCopyStatus({ number, result: "failed" });
    }
  }

  async function confirmMerge() {
    if (!mergeTarget || isMerging) return;
    setIsMerging(true);
    setMergeError("");
    try {
      const { csrfToken } = await getJson<{ csrfToken: string }>("/api/session");
      await getJson(`/api/prs/${mergeTarget.number}/merge`, {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken, "Content-Type": "application/json" },
        body: JSON.stringify({ expectedHeadSha: mergeTarget.headRefOid }),
      });
      setMergeNotice(`PR #${mergeTarget.number} merged.`);
      setMergeTarget(null);
      setDetail(null);
      setFilter("Merged");
      setListVersion((version) => version + 1);
    } catch (failure) {
      setMergeError((failure as Error).message);
    } finally {
      setIsMerging(false);
    }
  }

  function toggleViewed(file: PrFile) {
    if (selectedNumber === null) return;
    try {
      const { markers } = readViewedState(selectedNumber, files?.items ?? [file]);
      const nextMarkers = file.viewed
        ? Object.fromEntries(Object.entries(markers).filter(([path]) => path !== file.path))
        : { ...markers, [file.path]: file.sha };
      window.localStorage.setItem(viewedStorageKey(selectedNumber), JSON.stringify(nextMarkers));
      setFiles((current) => current && current.number === selectedNumber
        ? { ...current, items: current.items.map((entry) => entry.path === file.path ? { ...entry, viewed: !file.viewed } : entry) }
        : current);
      setExpandedViewedFiles((current) => {
        const next = new Set(current);
        next.delete(`${selectedNumber}:${file.path}`);
        return next;
      });
      setViewedError(null);
    } catch (failure) {
      setViewedError({ number: selectedNumber, message: `Could not save Viewed in this browser: ${(failure as Error).message}` });
    }
  }

  return (
    <section className="pr-browser" aria-label="Pull requests">
      {mergeNotice ? <div className="alert alert-success" role="status">{mergeNotice}</div> : null}
      <div className="section-heading pr-browser-heading">
        <div><span className="eyebrow">GITHUB</span><h2>Pull requests <span className="count-badge">{items?.length ?? 0}</span></h2></div>
        <span className="muted">Recent PRs · up to 100 per status</span>
      </div>
      <div className={`pr-browser-card ${tab === "Files changed" ? "showing-files" : ""}`}>
        <div className="pr-list-panel">
          <div className="pr-filters" aria-label="PR status filter">
            {filters.map((option) => <button key={option} type="button" className={filter === option ? "active" : ""} aria-pressed={filter === option} onClick={() => selectFilter(option)}>{option}</button>)}
          </div>
          {listError ? <p role="alert" className="pr-message">{listError}</p> : items === null ? <p className="pr-message">Loading pull requests…</p> : visibleItems.length === 0 ? <p className="pr-message">No pull requests found.</p> : (
            <div className="pr-list">
              {visibleItems.map((pr) => <button type="button" className={`pr-list-item ${selectedNumber === pr.number ? "selected" : ""}`} key={pr.number} aria-current={selectedNumber === pr.number ? "true" : undefined} aria-label={`PR #${pr.number} ${pr.title}`} onClick={() => selectPr(pr.number)}>
                <span className="pr-list-title"><span className="pr-number">#{pr.number}</span> {pr.title}</span>
                <span className="pr-list-meta"><span>{pr.headRefName} → {pr.baseRefName}</span><span className={`pill ${pr.state.toLowerCase()}`}>{stateLabel(pr)}</span><span>Review: {pr.reviewDecision ?? "pending"}</span><span className={`check-indicator ${pr.checkStatus}`}>Checks: {pr.checkStatus}</span></span>
              </button>)}
            </div>
          )}
        </div>
        <div className="pr-detail-panel">
          {selectedNumber === null ? <p className="pr-message">Select a pull request to see its status and comments.</p> : detailError ? <p role="alert" className="pr-message">{detailError}</p> : !detail || detail.number !== selectedNumber ? <p className="pr-message">Loading PR details…</p> : (
            <>
              <div className="pr-detail-header"><div><span className="eyebrow">PR #{detail.number}</span><h3>{detail.title}</h3></div><div className="pr-detail-actions">{githubUrl(detail.url) ? <button type="button" onClick={() => void copyPrUrl(detail.number, detail.url)}>{copyButtonText}</button> : null}{detail.state === "OPEN" && !detail.isDraft && detail.headRefOid ? <button type="button" className="button button-primary" onClick={() => { setMergeError(""); setMergeTarget(detail); }}>Merge</button> : null}</div></div>
              <div className="pr-detail-status"><span className={`pill ${detail.state.toLowerCase()}`}>{stateLabel(detail)}</span><span>Review: <strong>{detail.reviewDecision ?? "Pending"}</strong></span><span className={`check-indicator ${detail.checkStatus}`}>Checks: {detail.checkStatus}</span></div>
              {detail.body ? <p className="pr-detail-body">{detail.body}</p> : null}
              <div className="pr-detail-tabs" role="tablist" aria-label="PR detail">
                {(["Conversation", "Commits", "Files changed"] as const).map((option) => <button key={option} type="button" role="tab" aria-selected={tab === option} onClick={() => setTab(option)}>{option}</button>)}
              </div>
              {tab === "Conversation" ? (
                <>
                  <h4>Checks</h4>
                  {detail.checks.length ? <ul className="checks-list">{detail.checks.map((check, index) => <li key={`${check.name}-${index}`}><span className={`check-dot ${(check.conclusion ?? check.status).toLowerCase()}`} /><span>{check.name}</span><small>{check.conclusion ?? check.status}</small></li>)}</ul> : <p className="muted">No checks reported.</p>}
                  <h4>Comments <span className="count-badge">{comments.length}</span></h4>
                  <div aria-label="Comments" className="pr-comments">{comments.length ? comments.map((comment, index) => <article className="pr-comment" key={`${comment.url}-${index}`}>
                    <div className="pr-comment-heading"><strong>{comment.author}</strong><span>{comment.kind}</span><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time>{githubUrl(comment.url) ? <a href={githubUrl(comment.url)} target="_blank" rel="noopener noreferrer">View comment ↗</a> : null}</div>
                    {comment.path ? <div className="pr-comment-path">{comment.path}{comment.line != null ? `:${comment.line}` : ""}</div> : null}
                    <p>{comment.body}</p>
                  </article>) : <p className="muted">No comments yet.</p>}</div>
                </>
              ) : tabError ? <p role="alert" className="pr-message">{tabError}</p> : tab === "Commits" ? (
                commits?.number === selectedNumber ? <ol className="pr-commit-list">{commits.items.map((commit) => <li key={commit.sha}><code>{commit.sha.slice(0, 8)}</code><strong>{commit.subject}</strong><span>{commit.author}</span><time dateTime={commit.authoredAt}>{new Date(commit.authoredAt).toLocaleString()}</time></li>)}</ol> : <p className="pr-message">Loading commits…</p>
              ) : files?.number === selectedNumber ? (
                files.items.length ? <div className="pr-files-layout">
                  <nav className="pr-file-nav" aria-label="Changed files in PR">
                    <strong>Changed files <span className="count-badge">{files.items.length}</span></strong>
                    <span className="viewed-count">{files.items.filter((file) => file.viewed).length} of {files.items.length} viewed</span>
                    {files.items.map((file, index) => <a href={`#pr-${selectedNumber}-file-${index}`} key={file.path} title={file.path}>{file.viewed ? <span className="viewed-icon" aria-hidden="true">✓</span> : null}{file.path}</a>)}
                  </nav>
                  <div className="pr-files">{viewedError && (viewedError.number === null || viewedError.number === selectedNumber) ? <p className="alert alert-error" role="alert">{viewedError.message}</p> : null}{files.items.map((file, fileIndex) => {
                    const fileKey = `${selectedNumber}:${file.path}`;
                    const isCollapsed = file.viewed && !expandedViewedFiles.has(fileKey);
                    return <article className={`pr-file ${file.viewed ? "is-viewed" : ""}`} id={`pr-${selectedNumber}-file-${fileIndex}`} key={file.path}>
                      <div className="pr-file-heading"><strong>{file.path}</strong><span>{file.status}</span><span className="additions">+{file.additions}</span><span className="deletions">−{file.deletions}</span>
                        {file.viewed ? <button type="button" className="file-expand" aria-label={`${isCollapsed ? "Show" : "Hide"} file ${file.path}`} aria-expanded={!isCollapsed} onClick={() => setExpandedViewedFiles((current) => {
                          const next = new Set(current);
                          if (isCollapsed) next.add(fileKey);
                          else next.delete(fileKey);
                          return next;
                        })}>{isCollapsed ? "Show file" : "Hide file"}</button> : null}
                        <label className="viewed-control"><input type="checkbox" aria-label={`Viewed ${file.path}`} checked={file.viewed} onChange={() => toggleViewed(file)} />Viewed</label></div>
                      {!isCollapsed ? <>{file.oldPath ? <p className="muted">Renamed from {file.oldPath}</p> : null}
                        {!file.patchAvailable ? <p className="pr-message">GitHub has no text patch for this file (binary or too large).</p> : file.hunks.map((hunk, index) => <div className="hunk" key={`${hunk.header}-${index}`}><div className="hunk-header">{hunk.header}</div>{hunk.lines.map((line, lineIndex) => <div className={`diff-line line-${line.kind}`} key={lineIndex}><span className="line-number">{line.oldNumber ?? ""}</span><span className="line-number">{line.newNumber ?? ""}</span><span className="line-content"><span className="line-prefix">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</span>{line.content}</span></div>)}</div>)}</> : null}
                    </article>;
                  })}</div>
                </div> : <p className="pr-message">No files changed.</p>
              ) : <p className="pr-message">Loading files…</p>}
            </>
          )}
          {selectedItem && detailError ? <p className="muted">#{selectedItem.number} {selectedItem.title}</p> : null}
        </div>
      </div>
      {mergeTarget ? <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="merge-heading">
        <h2 id="merge-heading">Merge pull request</h2>
        <p>Merge PR #{mergeTarget.number} into <strong>{mergeTarget.baseRefName}</strong>? GitHub will check whether the PR can be merged.</p>
        {mergeError ? <div className="alert alert-error" role="alert">{mergeError}</div> : null}
        <div className="modal-actions"><button type="button" className="button button-secondary" disabled={isMerging} onClick={() => setMergeTarget(null)}>Cancel</button><button type="button" className="button button-primary" disabled={isMerging} onClick={() => void confirmMerge()}>{isMerging ? "Merging…" : "Confirm merge"}</button></div>
      </div></div> : null}
    </section>
  );
}
