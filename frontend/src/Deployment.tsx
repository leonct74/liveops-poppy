// The deployment panel: what LiveOpsPoppy has in the studio's AWS account, and the two
// buttons that change it. State is READ FROM AWS on every mount and while work is in
// flight (AGENTS.md §5) — the UI remembers nothing, so closing the app mid-deploy and
// coming back lands on live progress instead of a dead spinner.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import type { Api } from "./api";
import type { DeploymentStatus } from "./types";

/** Exported so the poll regression test paces itself off the real interval. */
export const POLL_MS = 4000;

const PHASE_LABEL: Record<DeploymentStatus["phase"], string> = {
  none: "Not deployed",
  deploying: "Setting up…",
  ready: "Running",
  removing: "Removing…",
  failed: "Needs attention",
};

export function Deployment({ api, onChange }: { api: Api; onChange?: (s: DeploymentStatus) => void }) {
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const next = await api.status();
      setStatus(next);
      onChange?.(next);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, onChange]);

  useEffect(() => {
    void refresh();
    return () => window.clearTimeout(timer.current);
  }, [refresh]);

  // Poll only while AWS is actually working — an idle poppy makes no calls at all.
  //
  // 🪤 The chain RESCHEDULES ITSELF (the same shape as App's status probe) rather than
  // leaning on this effect re-running. A deploy sits at CREATE_IN_PROGRESS for ~2 minutes,
  // during which EVERY dep here holds an identical value tick after tick: `inProgress` is
  // `true`, `stackStatus` is the same string, and `refresh` is stable because the parent
  // passes `onChange={setStatus}` — a React state setter never changes identity. React
  // skips an effect whose deps are unchanged, so the re-run this used to depend on is
  // exactly the thing that never happened: it scheduled ONE timeout, then stopped polling
  // for good while the CSS spinner kept animating over frozen state. The stack reached
  // CREATE_COMPLETE and the panel still read "Setting up…" until you remounted the tab
  // (founder field report, 2026-08-14). Any "spinner never stops" bug starts here.
  useEffect(() => {
    if (!status?.inProgress) return;
    let cancelled = false;
    const tick = async () => {
      await refresh();
      // Re-armed only after the previous read RESOLVES, so a slow describe can never
      // stack up overlapping polls.
      if (!cancelled) timer.current = window.setTimeout(() => void tick(), POLL_MS);
    };
    timer.current = window.setTimeout(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer.current);
    };
  }, [status?.inProgress, refresh]);

  if (!status) {
    // An error before the FIRST successful read must replace the skeleton, not sit behind
    // it: otherwise a revoked connection (or running outside the host) shows a placeholder
    // that never resolves and says nothing.
    return (
      <div className="card">
        {error ? (
          <div className="banner err">{error}</div>
        ) : (
          <div className="skeleton" style={{ height: 18, width: 180, borderRadius: 6 }} />
        )}
      </div>
    );
  }

  const badgeClass =
    status.phase === "ready" ? "badge ok" : status.phase === "failed" ? "badge warn" : "badge run";

  return (
    <div className="card">
      <div className="spread">
        <div>
          <div className="section-title">Your AWS account</div>
          <div className="row">
            <span className={badgeClass}>
              {/* While CloudFormation works (~2 min) the ONLY feedback is this badge — a
                  static dot reads as a dead app (founder field report, 2026-08-11). The
                  design kit's spinner shows motion; the line below shows real progress. */}
              {status.inProgress ? <span className="spinner" aria-label="working" /> : <span className="dot" />}{" "}
              {PHASE_LABEL[status.phase]}
            </span>
            <span className="muted">{status.region}</span>
          </div>
          {status.inProgress && (
            <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
              CloudFormation is {status.phase === "removing" ? "removing" : "building"} your stack
              {status.stackStatus ? ` (${status.stackStatus})` : ""} — usually about two minutes.
              This panel refreshes itself every few seconds.
            </p>
          )}
        </div>
        <div className="row">
          {status.phase === "none" && (
            <Button
              className="btn btn-primary"
              busyLabel="Starting…"
              onClick={async () => {
                setError(null);
                try {
                  await api.deploy();
                  await refresh();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Set up my backend
            </Button>
          )}
          {status.phase === "ready" && status.updateAvailable && (
            <Button
              className="btn btn-primary"
              busyLabel="Updating…"
              onClick={async () => {
                setError(null);
                try {
                  await api.deploy();
                  await refresh();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Update backend
            </Button>
          )}
          {(status.phase === "ready" || status.phase === "failed") && !confirmRemove && (
            <button className="btn btn-sm btn-danger" onClick={() => setConfirmRemove(true)}>
              Remove everything
            </button>
          )}
        </div>
      </div>

      {status.phase === "ready" && status.collectorUrl && (
        <p className="muted" style={{ marginBottom: 0, marginTop: 12, fontSize: 13 }}>
          Your games talk to <span className="chip">{status.collectorUrl}</span>
        </p>
      )}

      {/* An app older than the deployed backend must never offer to "update" it — that
          would roll the backend BACKWARDS. Say so instead (MailPoppy's 07-29 footgun). */}
      {status.appOutdated && (
        <p className="banner info" style={{ marginTop: 12 }}>
          Your deployed backend is newer than this version of LiveOpsPoppy. Update the app in
          AgentsPoppy — deploying from here would roll your backend backwards.
        </p>
      )}

      {status.phase === "failed" && (
        <div className="banner err" style={{ marginTop: 12 }}>
          <div>{status.message}</div>
          {status.failureReason && (
            <div className="mono muted" style={{ marginTop: 6, fontSize: 12 }}>
              {status.failureReason}
            </div>
          )}
        </div>
      )}

      {confirmRemove && (
        // Inline confirm, never window.confirm: the host webview may not render it, and a
        // destructive action that silently does nothing is worse than no button.
        <div className="banner err" style={{ marginTop: 12 }}>
          <p style={{ marginTop: 0 }}>
            This deletes the stack, the table and every event, session and config version it
            holds. It cannot be undone.
          </p>
          <div className="row">
            <Button
              className="btn btn-sm btn-danger"
              busyLabel="Removing…"
              onClick={async () => {
                setError(null);
                try {
                  await api.teardown();
                  setConfirmRemove(false);
                  await refresh();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Yes, remove everything
            </Button>
            <button className="btn btn-sm" onClick={() => setConfirmRemove(false)}>
              Keep it
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="banner err" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}
