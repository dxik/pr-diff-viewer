import PullRequestBrowser from "./PullRequestBrowser";
import "./styles.css";

export default function App() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">&lt;/&gt;</span><span>PR<span className="brand-light">Review</span></span></div>
        <span className="local-badge"><span className="online-dot" /> GitHub via gh</span>
      </header>
      <main className="workspace">
        <section className="intro pr-page-intro">
          <div>
            <div className="eyebrow">PaulSklarXfit/psxfit365-monorepo</div>
            <h1>Pull requests</h1>
            <p>Browse reviews, commits, comments, and code changes from GitHub.</p>
          </div>
        </section>
        <PullRequestBrowser />
      </main>
    </div>
  );
}
