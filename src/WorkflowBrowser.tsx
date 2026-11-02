import { useEffect, useState } from "react";

type Workflow = { id: number; name: string; path: string; state: string };
type WorkflowRun = {
  id: number; workflowId: number; name: string; title: string; status: string;
  conclusion: string | null; branch: string; event: string; createdAt: string;
  runNumber: number; url: string; actor: string;
};

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const data: unknown = await response.json();
  if (!response.ok) throw new Error((data as { error?: string; message?: string }).error ?? (data as { message?: string }).message ?? "Request failed");
  return data as T;
}

function runUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && url.pathname.startsWith("/PaulSklarXfit/psxfit365-monorepo/actions/runs/") ? url.href : undefined;
  } catch { return undefined; }
}

function runStatus(run: WorkflowRun): { label: string; style: string } {
  if (run.status !== "completed") return { label: run.status.replaceAll("_", " "), style: "pending" };
  if (run.conclusion === "success") return { label: "Success", style: "success" };
  if (run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "action_required") return { label: (run.conclusion ?? "failure").replaceAll("_", " "), style: "failure" };
  return { label: (run.conclusion ?? "Completed").replaceAll("_", " "), style: "neutral" };
}

export default function WorkflowBrowser() {
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [workflowId, setWorkflowId] = useState<number | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [workflowError, setWorkflowError] = useState("");
  const [runsError, setRunsError] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let current = true;
    setWorkflowError("");
    getJson<{ workflows: Workflow[] }>("/api/actions/workflows")
      .then((result) => { if (current) setWorkflows(result.workflows); })
      .catch((error: Error) => { if (current) setWorkflowError(error.message); });
    return () => { current = false; };
  }, [refresh]);

  useEffect(() => {
    let current = true;
    setRuns(null);
    setRunsError("");
    const query = new URLSearchParams({ page: String(page) });
    if (workflowId !== null) query.set("workflow", String(workflowId));
    getJson<{ runs: WorkflowRun[]; totalCount: number }>(`/api/actions/runs?${query}`)
      .then((result) => { if (current) { setRuns(result.runs); setTotalCount(result.totalCount); } })
      .catch((error: Error) => { if (current) setRunsError(error.message); });
    return () => { current = false; };
  }, [workflowId, page, refresh]);

  function selectWorkflow(id: number | null) {
    setWorkflowId(id);
    setPage(1);
  }

  const title = workflowId === null ? "All workflows" : workflows?.find((workflow) => workflow.id === workflowId)?.name ?? "Workflow runs";
  return <section className="actions-browser" aria-label="Actions workflows">
    <div className="actions-layout">
      <aside className="actions-sidebar" aria-label="Workflows">
        <h2>Workflows</h2>
        <button type="button" className={`workflow-filter ${workflowId === null ? "active" : ""}`} aria-pressed={workflowId === null} onClick={() => selectWorkflow(null)}>All workflows</button>
        {workflowError ? <p className="actions-error" role="alert">{workflowError}</p> : workflows === null ? <p className="muted">Loading workflows...</p> : workflows.length === 0 ? <p className="muted">No workflows found.</p> : workflows.map((workflow) => <button type="button" key={workflow.id} className={`workflow-filter ${workflowId === workflow.id ? "active" : ""}`} aria-pressed={workflowId === workflow.id} title={workflow.path} onClick={() => selectWorkflow(workflow.id)}>{workflow.name}{workflow.state !== "active" ? <span>{workflow.state.replaceAll("_", " ")}</span> : null}</button>)}
      </aside>
      <div className="actions-content">
        <div className="actions-heading"><div><span className="eyebrow">WORKFLOW RUNS</span><h2>{title}</h2>{runs !== null ? <p>{totalCount} runs</p> : null}</div><button type="button" className="button button-secondary" onClick={() => setRefresh((value) => value + 1)}>Refresh</button></div>
        {runsError ? <p role="alert" className="actions-message">{runsError}</p> : runs === null ? <p className="actions-message">Loading workflow runs...</p> : runs.length === 0 ? <p className="actions-message">No workflow runs found.</p> : <ul className="actions-run-list">{runs.map((run) => {
          const status = runStatus(run);
          const url = runUrl(run.url);
          const date = new Date(run.createdAt);
          return <li className="actions-run" key={run.id}>
            <span className={`actions-status-dot ${status.style}`} aria-hidden="true" />
            <div className="actions-run-content"><div className="actions-run-title">{url ? <a href={url} target="_blank" rel="noopener noreferrer">{run.title || run.name}</a> : <strong>{run.title || run.name}</strong>}<span className={`actions-status ${status.style}`}>{status.label}</span></div>
              <div className="actions-run-meta"><span>{run.name} #{run.runNumber}</span><span>{run.branch || "Unknown branch"}</span><span>{run.event}</span><span>{run.actor}</span><time dateTime={run.createdAt}>{Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleString()}</time></div></div>
          </li>;
        })}</ul>}
        {runs !== null && totalCount > 30 ? <div className="actions-pagination"><button className="button button-secondary" type="button" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>Previous</button><span>Page {page}</span><button className="button button-secondary" type="button" disabled={page * 30 >= totalCount || page >= 1000} onClick={() => setPage((value) => value + 1)}>Next</button></div> : null}
      </div>
    </div>
  </section>;
}
