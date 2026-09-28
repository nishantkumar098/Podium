"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { api } from "../../../lib/api";

/**
 * Google sends the person back here after they approve access. The one-time
 * code is handed to the API, which exchanges it for tokens server-side (the
 * client secret never reaches the browser), then we return to Mail.
 */
function Connect() {
  const params = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // a code can only be exchanged once
    started.current = true;
    const code = params.get("code");
    const denied = params.get("error");
    if (denied || !code) {
      setError(denied === "access_denied" ? "Google access was not granted." : "Google did not return an authorization code.");
      return;
    }
    api
      .post("/integrations/google/callback", { code })
      .then(() => router.replace("/mail"))
      .catch((e: Error) => setError(e.message));
  }, [params, router]);

  return (
    <div className="center-screen">
      {error ? (
        <div className="panel" style={{ maxWidth: 440 }}>
          <div className="panel-title">Couldn&apos;t connect Google</div>
          <p className="small">{error}</p>
          <button className="btn-primary" style={{ marginTop: 12 }} onClick={() => router.replace("/mail")}>
            Back to Mail
          </button>
        </div>
      ) : (
        <div className="muted">Connecting your Google account…</div>
      )}
    </div>
  );
}

export default function MailConnectPage() {
  return (
    <Suspense fallback={<div className="center-screen muted">Connecting…</div>}>
      <Connect />
    </Suspense>
  );
}
