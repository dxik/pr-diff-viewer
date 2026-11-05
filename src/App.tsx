import { useState } from "react";
import WorkflowBrowser from "./WorkflowBrowser";
import PullRequestBrowser from "./PullRequestBrowser";
import CompareBrowser from "./CompareBrowser";
import "./styles.css";

export default function App() {
  const [page, setPage] = useState<"pulls" | "actions" | "compare">("pulls");
  const [createdPr, setCreatedPr] = useState<number | null>(null);
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">&lt;/&gt;</span><span>PR<span className="brand-light">Review</span></span></div>
        <span className="local-badge"><span className="online-dot" /> GitHub via gh</span>
      </header>
      <main className="workspace">
        <nav className="app-navigation" aria-label="Repository navigation">
          <button type="button" aria-current={page !== "actions" ? "page" : undefined} onClick={() => setPage("pulls")}>Pull requests</button>
          <button type="button" aria-current={page === "actions" ? "page" : undefined} onClick={() => setPage("actions")}>Actions</button>
        </nav>
        <section className="intro pr-page-intro">
          <div>
            <div className="eyebrow">PaulSklarXfit/psxfit365-monorepo</div>
            <h1>{page === "actions" ? "Actions" : "Pull requests"}</h1>
            <p>{page === "actions" ? "Browse workflow runs and their status from GitHub." : "Browse reviews, commits, comments, and code changes from GitHub."}</p>
          </div>
          {page === "pulls" ? <button type="button" className="button button-primary" onClick={() => { setCreatedPr(null); setPage("compare"); }}>New pull request</button> : null}
        </section>
        {page === "pulls" ? <>{createdPr ? <div className="alert alert-success" role="status">PR #{createdPr} created.</div> : null}<PullRequestBrowser initialPrNumber={createdPr} /></> : page === "compare" ? <CompareBrowser onCancel={() => setPage("pulls")} onCreated={(number) => { setCreatedPr(number); setPage("pulls"); }} /> : <WorkflowBrowser />}
      </main>
    </div>
  );
}
