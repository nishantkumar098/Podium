"use client";

import { useState, type FormEvent } from "react";
import { ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";

const MIN_LENGTH = 10;

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  // Set when the server says this account has no password yet (428): the
  // password being typed will become permanent, so it is asked for twice.
  const [firstLogin, setFirstLogin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (firstLogin) {
      if (password.length < MIN_LENGTH) return setError(`Choose a password of at least ${MIN_LENGTH} characters.`);
      if (password !== confirm) return setError("The two passwords don't match.");
    }
    setSubmitting(true);
    try {
      await login(username, password, firstLogin ? confirm : undefined);
    } catch (err) {
      if (err instanceof ApiError && err.status === 428) {
        setFirstLogin(true);
        setConfirm("");
      } else {
        setError(err instanceof ApiError ? err.message : "Could not sign in.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="center-screen">
      <div className="login-card">
        <div className="brandmark" style={{ padding: 0, border: "none", marginBottom: 18 }}>
          <div className="mark">P</div>
          <div className="names">
            <div className="company" style={{ color: "var(--ink)" }}>
              Podium
            </div>
            <div className="sub" style={{ color: "var(--text-dim)" }}>
              AMM Brands LLP
            </div>
          </div>
        </div>
        <div className="login-title">{firstLogin ? "Set your password" : "Sign in"}</div>
        <div className="login-sub">
          {firstLogin
            ? "This is your first sign-in. The password you choose now is permanent — only an Admin can reset it."
            : "Event production & bar operations, six cities."}
        </div>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={onSubmit}>
          <div className="field" style={{ marginBottom: 12 }}>
            <label htmlFor="username">Username</label>
            <input
              id="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="Your name, e.g. shweta.singh"
              value={username}
              readOnly={firstLogin}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div className="field" style={{ marginBottom: 12 }}>
            <label htmlFor="password">{firstLogin ? "New password" : "Password"}</label>
            <input
              id="password"
              type="password"
              autoComplete={firstLogin ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {firstLogin && (
            <div className="field" style={{ marginBottom: 4 }}>
              <label htmlFor="confirm">Type it again</label>
              <input
                id="confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
              <div className="small muted" style={{ marginTop: 4 }}>
                At least {MIN_LENGTH} characters.
              </div>
            </div>
          )}
          <button type="submit" className="btn-primary full-btn" disabled={submitting}>
            {submitting ? "Please wait…" : firstLogin ? "Set password & sign in" : "Sign in"}
          </button>
          {firstLogin && (
            <button
              type="button"
              className="btn-ghost full-btn"
              style={{ marginTop: 8 }}
              onClick={() => {
                setFirstLogin(false);
                setPassword("");
                setConfirm("");
                setError(null);
              }}
            >
              Back
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
