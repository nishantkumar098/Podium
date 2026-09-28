"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "../../components/AppShell";
import { DocumentsPanel } from "../../components/DocumentsPanel";
import { api } from "../../lib/api";
import type { DocumentDto } from "../../lib/types";

export default function DocumentsPage() {
  const [uploadOpen, setUploadOpen] = useState(false);
  // Same query key as the panel, so this is served from the one request.
  const { data } = useQuery({ queryKey: ["documents", "all"], queryFn: () => api.get<DocumentDto[]>("/documents") });

  return (
    <AppShell crumb="Documents">
      <div className="page-head">
        <div>
          <div className="page-title">Documents</div>
          <div className="page-sub">{data ? `${data.length} file${data.length === 1 ? "" : "s"} across all projects` : "Loading…"}</div>
        </div>
        <div className="page-actions">
          <button className="btn-primary" onClick={() => setUploadOpen(!uploadOpen)}>
            {uploadOpen ? "Close" : "+ Upload"}
          </button>
        </div>
      </div>
      <DocumentsPanel uploadOpen={uploadOpen} onUploadOpenChange={setUploadOpen} />
    </AppShell>
  );
}
