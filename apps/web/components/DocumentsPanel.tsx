"use client";

import { fmtDate } from "@podium/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { api, apiDownload, apiUpload, ApiError } from "../lib/api";
import type { DocumentDto, DocumentType, ProjectDto } from "../lib/types";

const DOCUMENT_TYPES: DocumentType[] = ["CONTRACT", "DESIGN", "CREATIVE", "PURCHASE_ORDER", "GOVERNMENT_PERMIT", "GUEST_LIST", "OTHER"];

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * Documents (Phase F, blueprint §26). Embedded on a project's detail page
 * (projectId set — every upload is scoped to that project, no project
 * picker shown) and reused standalone at /documents for workspace-level
 * documents (no projectId — a project picker is shown per upload).
 */
/**
 * `uploadOpen`/`onUploadOpenChange` let a page put the Upload button in its
 * own header (the /documents screen does, as the reference design has it);
 * without them the panel shows its own button.
 */
export function DocumentsPanel({
  projectId,
  uploadOpen,
  onUploadOpenChange,
}: {
  projectId?: string;
  uploadOpen?: boolean;
  onUploadOpenChange?: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [ownUpload, setOwnUpload] = useState(false);
  const controlled = uploadOpen !== undefined;
  const showUpload = controlled ? uploadOpen : ownUpload;
  const setShowUpload = (v: boolean) => (controlled ? onUploadOpenChange?.(v) : setOwnUpload(v));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data: documents, isLoading } = useQuery({
    queryKey: ["documents", projectId ?? "all"],
    queryFn: () => api.get<DocumentDto[]>(`/documents${projectId ? `?projectId=${projectId}` : ""}`),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["documents", projectId ?? "all"] });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/documents/${id}`),
    onSuccess: () => { setError(null); refresh(); },
    onError: (e: ApiError) => setError(e.message),
  });

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const download = async (versionId: string, fileName: string) => {
    try {
      await apiDownload(`/document-versions/${versionId}/download`, fileName);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Download failed.");
    }
  };

  return (
    <div>
      {error && (
        <div className="panel" style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 14, display: "flex", justifyContent: "space-between" }}>
          <span className="small">{error}</span>
          <button className="btn-ghost btn-sm" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {!controlled && (
        <div className="page-actions" style={{ marginBottom: 14 }}>
          <button className="btn-primary" onClick={() => setShowUpload(!showUpload)}>
            {showUpload ? "Close" : "Upload document"}
          </button>
        </div>
      )}

      {showUpload && (
        <UploadForm
          projectId={projectId}
          onDone={() => { setShowUpload(false); setError(null); refresh(); }}
          onError={(e) => setError(e.message)}
        />
      )}

      <div className="panel">
        {isLoading && <div className="empty">Loading…</div>}
        {!isLoading && (documents?.length ?? 0) === 0 && <div className="empty">No documents yet.</div>}
        {(documents?.length ?? 0) > 0 && (
          <table>
            <thead>
              <tr>
                <th>Document</th>
                {!projectId && <th>Project</th>}
                <th>Type</th>
                <th>Uploaded</th>
                <th>By</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {documents!.map((d) => {
                const latest = d.versions[0];
                const isExpanded = expanded.has(d.id);
                return (
                  <Fragment key={d.id}>
                    <tr>
                      <td>
                        <span className="linkish" onClick={() => toggleExpand(d.id)}>
                          {d.versions.length > 1 ? (isExpanded ? "▾ " : "▸ ") : ""}{d.name}
                        </span>
                        <div className="small faint">
                          {latest ? fmtBytes(latest.sizeBytes) : "—"}
                          {d.versions.length > 1 ? ` · v${latest?.versionNo} of ${d.versions.length}` : ""}
                        </div>
                      </td>
                      {!projectId && <td>{d.project?.name ?? "Company-wide"}</td>}
                      <td><span className="pill gray">{d.type.charAt(0) + d.type.slice(1).toLowerCase().replace(/_/g, " ")}</span></td>
                      <td className="mono">{fmtDate(latest?.createdAt ?? d.createdAt)}</td>
                      <td>{latest?.uploadedBy?.name ?? "—"}</td>
                      <td style={{ display: "flex", gap: 6 }}>
                        {latest && (
                          <button className="btn-ghost btn-sm" onClick={() => download(latest.id, latest.fileName)}>
                            Download
                          </button>
                        )}
                        <AddVersionButton documentId={d.id} onDone={() => { setError(null); refresh(); }} onError={(e) => setError(e.message)} />
                        <button className="btn-warn btn-sm" onClick={() => remove.mutate(d.id)}>Delete</button>
                      </td>
                    </tr>
                    {isExpanded && d.versions.length > 1 && (
                      <tr>
                        <td colSpan={projectId ? 5 : 6} style={{ background: "var(--bg-subtle, #FAF8F2)", padding: "8px 20px" }}>
                          {d.versions.map((v) => (
                            <div key={v.id} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 12 }}>
                              <span>v{v.versionNo} — {v.fileName} ({fmtBytes(v.sizeBytes)})</span>
                              <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                                <span className="mono small" style={{ color: "var(--text-faint)" }}>{fmtDate(v.createdAt)}</span>
                                <button className="btn-ghost btn-sm" onClick={() => download(v.id, v.fileName)}>Download</button>
                              </span>
                            </div>
                          ))}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function UploadForm({
  projectId,
  onDone,
  onError,
}: {
  projectId?: string;
  onDone: () => void;
  onError: (e: ApiError) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<DocumentType>("OTHER");
  const [targetProjectId, setTargetProjectId] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const { data: projects } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<ProjectDto[]>("/projects"),
    enabled: !projectId,
  });

  const upload = useMutation({
    mutationFn: () => {
      const formData = new FormData();
      formData.append(
        "meta",
        JSON.stringify({ name: name.trim(), type, projectId: projectId ?? (targetProjectId || undefined) }),
      );
      formData.append("file", file!);
      return apiUpload("/documents", formData);
    },
    onSuccess: onDone,
    onError: (e: ApiError) => onError(e),
  });

  const valid = name.trim() && file;

  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-title">Upload document</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 14, marginBottom: 14 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span className="small" style={{ color: "var(--text-dim)", fontWeight: 500 }}>Name</span>
          <input className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="Master Services Agreement" />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span className="small" style={{ color: "var(--text-dim)", fontWeight: 500 }}>Type</span>
          <select className="inp" value={type} onChange={(e) => setType(e.target.value as DocumentType)}>
            {DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
            ))}
          </select>
        </label>
        {!projectId && (
          <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span className="small" style={{ color: "var(--text-dim)", fontWeight: 500 }}>Project (optional)</span>
            <select className="inp" value={targetProjectId} onChange={(e) => setTargetProjectId(e.target.value)}>
              <option value="">Workspace-level (no project)</option>
              {projects?.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
        )}
        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span className="small" style={{ color: "var(--text-dim)", fontWeight: 500 }}>File</span>
          <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      </div>
      <div className="page-actions">
        <button className="btn-primary" disabled={!valid || upload.isPending} onClick={() => upload.mutate()}>
          {upload.isPending ? "Uploading…" : "Upload"}
        </button>
      </div>
    </div>
  );
}

function AddVersionButton({
  documentId,
  onDone,
  onError,
}: {
  documentId: string;
  onDone: () => void;
  onError: (e: ApiError) => void;
}) {
  const [open, setOpen] = useState(false);

  const addVersion = useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return apiUpload(`/documents/${documentId}/versions`, formData);
    },
    onSuccess: () => { setOpen(false); onDone(); },
    onError: (e: ApiError) => onError(e),
  });

  if (!open) return <button className="btn-ghost btn-sm" onClick={() => setOpen(true)}>+ Version</button>;

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <input
        type="file"
        style={{ maxWidth: 140, fontSize: 11 }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) addVersion.mutate(f);
        }}
      />
      <button className="btn-ghost btn-sm" onClick={() => setOpen(false)}>×</button>
    </span>
  );
}
