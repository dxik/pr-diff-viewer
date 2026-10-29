import { useEffect, useRef, useState } from "react";

type Field = "reviewers" | "assignees" | "labels" | "projects" | "milestone";
type Metadata = {
  reviewers: { name: string; status: string; requested: boolean }[];
  assignees: string[];
  labels: string[];
  milestone: string | null;
  isDraft: boolean;
};
type Props = { number: number; state: string; onDraftChange: (isDraft: boolean) => void };
const fields: { key: Field; label: string; empty: string }[] = [
  { key: "reviewers", label: "Reviewers", empty: "No reviewers" },
  { key: "assignees", label: "Assignees", empty: "No one assigned" },
  { key: "labels", label: "Labels", empty: "None yet" },
  { key: "projects", label: "Projects", empty: "None yet" },
  { key: "milestone", label: "Milestone", empty: "No milestone" },
];

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const result: unknown = await response.json();
  if (!response.ok) throw new Error((result as { error?: string; message?: string }).error ?? (result as { message?: string }).message ?? "Request failed");
  return result as T;
}

export default function PrMetadata({ number, state, onDraftChange }: Props) {
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [projects, setProjects] = useState<string[] | null>(null);
  const [metadataError, setMetadataError] = useState("");
  const [projectError, setProjectError] = useState("");
  const [menu, setMenu] = useState<Field | null>(null);
  const [options, setOptions] = useState<string[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const optionsVersion = useRef(0);
  const path = `/api/prs/${number}/metadata`;

  useEffect(() => {
    let current = true;
    request<Metadata>(path).then((value) => { if (current) setMetadata(value); }).catch((failure: Error) => { if (current) setMetadataError(failure.message); });
    request<{ projects: string[] }>(`${path}/projects`).then((value) => { if (current) setProjects(value.projects); }).catch(() => { if (current) setProjectError("Could not load projects. Check access and run gh auth refresh -s project if needed."); });
    return () => { current = false; };
  }, [path]);

  async function openMenu(field: Field) {
    if (menu === field) { setMenu(null); return; }
    const version = ++optionsVersion.current;
    setMenu(field);
    setOptions(null);
    setSearch("");
    setError("");
    try {
      const result = await request<{ options: string[] }>(`${path}/options?field=${field}`);
      if (version === optionsVersion.current) setOptions(result.options);
    } catch (failure) {
      if (version === optionsVersion.current) setError((failure as Error).message);
    }
  }

  async function update(field: Field | "draft", action: "add" | "remove" | "set", value = "") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const { csrfToken } = await request<{ csrfToken: string }>("/api/session");
      await request(path, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ field, action, value }) });
      if (field === "projects") {
        const result = await request<{ projects: string[] }>(`${path}/projects`);
        setProjects(result.projects);
      } else {
        const result = await request<Metadata>(path);
        setMetadata(result);
        if (field === "draft") onDraftChange(result.isDraft);
      }
    } catch (failure) {
      setError(field === "projects" ? `${(failure as Error).message} Check project access (gh auth refresh -s project).` : (failure as Error).message);
    } finally { setBusy(false); }
  }

  function selected(field: Field): string[] {
    if (!metadata) return [];
    if (field === "reviewers") return metadata.reviewers.filter((reviewer) => reviewer.requested).map((reviewer) => reviewer.name);
    if (field === "projects") return projects ?? [];
    if (field === "milestone") return metadata.milestone ? [metadata.milestone] : [];
    return metadata[field];
  }

  if (metadataError) return <aside className="pr-metadata" aria-label="Pull request settings"><p role="alert">{metadataError}</p></aside>;
  if (!metadata) return <aside className="pr-metadata" aria-label="Pull request settings"><p className="muted">Loading PR settings...</p></aside>;

  return <aside className="pr-metadata" aria-label="Pull request settings">
    {error ? <p role="alert" className="metadata-error">{error}</p> : null}
    {fields.map(({ key, label, empty }) => {
      const values = key === "reviewers" ? metadata.reviewers.map((reviewer) => reviewer.name) : selected(key);
      const selectedValues = selected(key);
      const available = [...new Set([...(options ?? []), ...selectedValues])].filter((value) => value.toLowerCase().includes(search.toLowerCase()));
      return <section className="metadata-section" key={key}>
        <div className="metadata-heading"><h4>{label}</h4><button type="button" aria-label={`Edit ${label}`} aria-expanded={menu === key} disabled={busy || (key === "projects" && projects === null)} onClick={() => void openMenu(key)}>&#9881;</button></div>
        {key === "projects" && projectError ? <p className="metadata-error">{projectError}</p> : values.length ? <ul>{values.map((value) => <li key={value}>{value}{key === "reviewers" ? <small>{metadata.reviewers.find((reviewer) => reviewer.name === value)?.status.replaceAll("_", " ").toLowerCase()}</small> : null}</li>)}</ul> : <p>{empty}</p>}
        {key === "reviewers" && state === "OPEN" ? <p className="metadata-draft">{metadata.isDraft ? "Ready for review? " : "Still in progress? "}<button type="button" disabled={busy} onClick={() => void update("draft", metadata.isDraft ? "remove" : "add")}>{metadata.isDraft ? "Mark ready for review" : "Convert to draft"}</button></p> : null}
        {key === "assignees" ? <button type="button" className="metadata-link" disabled={busy} onClick={() => void update("assignees", "add", "@me")}>Assign yourself</button> : null}
        {menu === key ? <div className="metadata-menu">
          <label htmlFor={`metadata-search-${key}`}>Search {label.toLowerCase()}</label>
          <input id={`metadata-search-${key}`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Filter ${label.toLowerCase()}`} />
          {options === null ? <p>{error ? "Could not load options." : "Loading..."}</p> : available.length === 0 ? <p>No options found.</p> : <div className="metadata-options">{available.map((value) => <label key={value}><input type={key === "milestone" ? "radio" : "checkbox"} name={`metadata-${key}`} checked={selectedValues.includes(value)} disabled={busy} onChange={() => void update(key, key === "milestone" ? "set" : selectedValues.includes(value) ? "remove" : "add", value)} />{value}</label>)}</div>}
          {key === "milestone" && metadata.milestone ? <button type="button" className="metadata-link" disabled={busy} onClick={() => void update("milestone", "remove")}>Clear milestone</button> : null}
          <button type="button" className="metadata-close" onClick={() => setMenu(null)}>Done</button>
        </div> : null}
      </section>;
    })}
  </aside>;
}
