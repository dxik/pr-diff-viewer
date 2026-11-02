import { useState } from "react";
import WorkflowBrowser from "./WorkflowBrowser";
import PullRequestBrowser from "./PullRequestBrowser";
import "./styles.css";

export default function App() {
  const [page, setPage] = useState<"pulls" | "actions">("pulls");
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">&lt;/&gt;</span><span>PR<span className="brand-light">Review</span></span></div>
        <span className="local-badge"><span className="online-dot" /> GitHub via gh</span>
      </header>
      <main className="workspace">
        <nav className="app-navigation" aria-label="Repository navigation">
          <button type="button" aria-current={page === "pulls" ? "page" : undefined} onClick={() => setPage("pulls")}>Pull requests</button>
          <button type="button" aria-current={page === "actions" ? "page" : undefined} onClick={() => setPage("actions")}>Actions</button>
        </nav>
        <section className="intro pr-page-intro">
          <div>
            <div className="eyebrow">PaulSklarXfit/psxfit365-monorepo</div>
            <h1>{page === "pulls" ? "Pull requests" : "Actions"}</h1>
            <p>{page === "pulls" ? "Browse reviews, commits, comments, and code changes from GitHub." : "Browse workflow runs and their status from GitHub."}</p>
          </div>
        </section>
        {page === "pulls" ? <PullRequestBrowser /> : <WorkflowBrowser />}
      </main>
    </div>
  );
}
