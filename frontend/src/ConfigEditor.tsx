// The remote-config editor — the reason a studio installs this poppy: change balance,
// prices and feature flags in a live game without shipping a build through store review.
//
// Publishing is guarded by an INLINE confirm (never window.confirm — the host webview may
// not render it) because a publish reaches every running player within a minute.

import { useCallback, useEffect, useState } from "react";
import { Button } from "./Button";
import type { Api } from "./api";
import type { ConfigVersion, ConfigView, Env } from "./types";

const ENVS: Env[] = ["dev", "prod"];

/**
 * What a first config looks like. Deliberately three familiar LiveOps levers — an economy
 * price, two difficulty numbers, a feature switch — rather than an abstract `{"key":"value"}`:
 * the shape teaches what this document is FOR. The sample game (`sample-game/`) reads exactly
 * these keys, so publishing this and opening the game is a complete, visible round trip.
 */
const EXAMPLE_CONFIG = `{
  "balance": {
    "shotgunDamage": 34,
    "bossHealthMultiplier": 1.15
  },
  "shop": {
    "starterBundlePrice": 4.99,
    "weekendSaleActive": false
  }
}`;

export function ConfigEditor({ api, titleId, readOnly }: { api: Api; titleId: string; readOnly?: boolean }) {
  const [env, setEnv] = useState<Env>("prod");
  const [live, setLive] = useState<ConfigView | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [history, setHistory] = useState<ConfigVersion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [current, hist] = await Promise.all([
        api.getConfig(titleId, env),
        api.configHistory(titleId, env),
      ]);
      setLive(current);
      setDraft(current.json);
      setHistory(hist.versions);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, titleId, env]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Validate as they type: a config that isn't a JSON object can't publish, and finding
  // that out on click is one round-trip too late.
  const localError = validate(draft);
  const dirty = live !== null && draft !== live.json;
  // "Nothing here yet" — never published, and the draft is still the empty object the
  // backend hands back for an unpublished env. This is the state that needs teaching.
  const isEmpty = live?.version === 0 && draft.replace(/\s/g, "") === "{}";

  return (
    <div className="card">
      <div className="spread">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Remote config
        </div>
        <div className="tabs" role="tablist">
          {ENVS.map((e) => (
            <button
              key={e}
              role="tab"
              aria-selected={env === e}
              className={`tab ${env === e ? "active" : ""}`}
              onClick={() => setEnv(e)}
            >
              {e}
            </button>
          ))}
        </div>
      </div>

      <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
        {live && live.version > 0 ? (
          <>
            Live: <strong>v{live.version}</strong>
            {live.publishedAt && <> · published {new Date(live.publishedAt).toLocaleString()}</>}
            {live.note && <> · {live.note}</>}
          </>
        ) : (
          <>Nothing published yet — games fall back to the defaults in their own code.</>
        )}
      </p>

      {/* An empty box with no example told the user nothing about what to write — the
          honest answer ("any JSON object; they're YOUR game's settings, we never
          interpret them") is exactly the answer a blank textarea cannot give. So the
          unpublished state explains it and offers a starting point (founder field
          report, 2026-08-11). */}
      {isEmpty && (
        <div className="banner info" style={{ marginBottom: 10 }}>
          <p style={{ margin: "0 0 8px" }}>
            <strong>This document is yours to invent.</strong> Any JSON object works —
            LiveOpsPoppy stores and serves it, and never interprets it. Put in the numbers you
            want to change without shipping an update: prices, difficulty, feature switches.
            Your game reads each value <em>by name, with a fallback</em>, so a key you haven&apos;t
            published yet simply keeps the built-in default.
          </p>
          {!readOnly && (
            <button className="btn btn-sm" onClick={() => setDraft(EXAMPLE_CONFIG)}>
              Start from an example
            </button>
          )}
        </div>
      )}

      <textarea
        className="input"
        style={{ minHeight: 200 }}
        spellCheck={false}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="Config document"
      />

      {isEmpty && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
          With the example above published, a game asks for{" "}
          <code>balance.shotgunDamage</code> and gets 34 — change it here, publish, and every
          running copy picks it up within a minute. (The sample game in{" "}
          <code>sample-game/</code> reads exactly these keys.)
        </p>
      )}

      {localError && (
        <div className="banner err" style={{ marginTop: 8 }}>
          {localError}
        </div>
      )}

      {!readOnly && (
        <div className="row" style={{ marginTop: 10 }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 160 }}
            placeholder="What changed? (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {!confirming ? (
            <button
              className="btn btn-primary"
              disabled={!!localError || !dirty}
              onClick={() => setConfirming(true)}
            >
              Publish to {env}
            </button>
          ) : null}
          {dirty && (
            <button className="btn btn-sm btn-ghost" onClick={() => setDraft(live?.json ?? "")}>
              Discard changes
            </button>
          )}
        </div>
      )}

      {confirming && (
        <div className="banner info" style={{ marginTop: 10 }}>
          <p style={{ marginTop: 0 }}>
            {env === "prod"
              ? "This reaches every player running your game within about a minute. You can roll back to any earlier version at any time."
              : "This publishes to your dev environment only."}
          </p>
          <div className="row">
            <Button
              className="btn btn-sm btn-primary"
              busyLabel="Publishing…"
              onClick={async () => {
                setError(null);
                try {
                  await api.publishConfig(titleId, env, draft, note);
                  setNote("");
                  setConfirming(false);
                  await refresh();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Publish v{(live?.version ?? 0) + 1}
            </Button>
            <button className="btn btn-sm" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="section-title">History</div>
          <div className="stack">
            {history.map((v) => (
              <div key={v.version} className="spread">
                <div style={{ fontSize: 13 }}>
                  <span className="chip">v{v.version}</span>{" "}
                  <span className="muted">
                    {v.publishedAt ? new Date(v.publishedAt).toLocaleString() : ""}
                    {v.note ? ` · ${v.note}` : ""}
                  </span>
                </div>
                {!readOnly && v.version !== live?.version && (
                  <Button
                    className="btn btn-sm"
                    busyLabel="Rolling back…"
                    onClick={async () => {
                      setError(null);
                      try {
                        await api.rollbackConfig(titleId, env, v.version);
                        await refresh();
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Roll back
                  </Button>
                )}
              </div>
            ))}
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

/** Mirrors the server's rule (core.ts::validateConfigDoc) so the editor never lets a
 *  document through that the backend would reject. */
export function validate(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return "That isn't valid JSON yet.";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "Config must be a JSON object — { \"key\": value }, not a list or a bare value.";
  }
  if (new Blob([json]).size > 64 * 1024) return "Config is larger than 64 KB.";
  return null;
}
