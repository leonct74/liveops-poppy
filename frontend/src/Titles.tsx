// Titles: the studio's games. Creating one hands back a key that is shown EXACTLY ONCE —
// the UI has to make that unmissable, because the only recovery is a rotation.

import { useCallback, useEffect, useState } from "react";
import { Button } from "./Button";
import { CopyButton } from "./CopyButton";
import type { Api } from "./api";
import type { CreatedTitle, Title } from "./types";

export function Titles({
  api,
  readOnly,
  selectedId,
  onSelect,
}: {
  api: Api;
  /** Demo mode: everything renders, nothing mutates. */
  readOnly?: boolean;
  selectedId?: string;
  onSelect?: (id: string) => void;
}) {
  const [titles, setTitles] = useState<Title[] | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedTitle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rotated, setRotated] = useState<{ titleId: string; key: string } | null>(null);
  const [confirmRotate, setConfirmRotate] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { titles: list } = await api.listTitles();
      setTitles(list);
      if (!selectedId && list[0]) onSelect?.(list[0].titleId);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, onSelect, selectedId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="card">
      <div className="section-title">Titles</div>

      {titles === null && <div className="skeleton" style={{ height: 16, width: 220, borderRadius: 6 }} />}

      {titles?.length === 0 && (
        <p className="muted" style={{ marginTop: 0 }}>
          No titles yet. A title is one game — it gets its own id, key and dashboard.
        </p>
      )}

      <div className="stack">
        {titles?.map((t) => (
          <div
            key={t.titleId}
            className="card card-2"
            style={{
              marginBottom: 0,
              borderColor: t.titleId === selectedId ? "var(--poppy-accent)" : undefined,
            }}
          >
            <div className="spread">
              <div>
                <strong>{t.name}</strong>
                <div className="muted" style={{ fontSize: 12 }}>
                  <span className="mono">{t.titleId}</span> · cap {t.eventCap.toLocaleString()} events/day
                </div>
              </div>
              <div className="row">
                {t.titleId !== selectedId && (
                  <button className="btn btn-sm" onClick={() => onSelect?.(t.titleId)}>
                    Select
                  </button>
                )}
                {!readOnly && (
                  <button className="btn btn-sm btn-ghost" onClick={() => setConfirmRotate(t.titleId)}>
                    Rotate key
                  </button>
                )}
              </div>
            </div>

            {t.previousKeyValidUntil && (
              <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
                The previous key still works until {new Date(t.previousKeyValidUntil).toLocaleDateString()} —
                so builds already in players' hands keep running.
              </p>
            )}

            {confirmRotate === t.titleId && (
              <div className="banner info" style={{ marginTop: 10 }}>
                <p style={{ marginTop: 0 }}>
                  A new key is issued now. The current key keeps working for 7 days, so shipped
                  builds keep running while you roll out an update.
                </p>
                <div className="row">
                  <Button
                    className="btn btn-sm btn-primary"
                    busyLabel="Rotating…"
                    onClick={async () => {
                      setError(null);
                      try {
                        const { key } = await api.rotateKey(t.titleId);
                        setRotated({ titleId: t.titleId, key });
                        setConfirmRotate(null);
                        await refresh();
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Rotate the key
                  </Button>
                  <button className="btn btn-sm" onClick={() => setConfirmRotate(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {rotated?.titleId === t.titleId && (
              <OneTimeKey title="Your new title key" value={rotated.key} onDone={() => setRotated(null)} />
            )}
          </div>
        ))}
      </div>

      {!readOnly && (
        <div style={{ marginTop: 14 }}>
          <label className="field">
            <span>Add a title</span>
            <div className="row">
              <input
                className="input"
                style={{ flex: 1, minWidth: 180 }}
                placeholder="Sunken Keep"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Button
                className="btn btn-primary"
                busyLabel="Creating…"
                disabled={!name.trim()}
                onClick={async () => {
                  setError(null);
                  try {
                    const result = await api.createTitle(name.trim());
                    setCreated(result);
                    setName("");
                    await refresh();
                    onSelect?.(result.title.titleId);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Create
              </Button>
            </div>
          </label>
        </div>
      )}

      {created && (
        <OneTimeKey
          title={`Title key for ${created.title.name}`}
          value={created.key}
          onDone={() => setCreated(null)}
        />
      )}

      {error && (
        <div className="banner err" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}

/** The key reveal. Loud on purpose: we store only a hash, so this is genuinely the last
 *  time this value exists anywhere outside the developer's own notes and game build. */
function OneTimeKey({ title, value, onDone }: { title: string; value: string; onDone: () => void }) {
  return (
    <div className="keybox" style={{ marginTop: 12 }}>
      <strong>{title}</strong>
      <code>{value}</code>
      <div className="row">
        <CopyButton text={value} label="title key" />
        <button className="btn btn-sm" onClick={onDone}>
          I've saved it
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0, marginTop: 8 }}>
        Copy it now — LiveOpsPoppy stores only a hash of this key and can never show it again.
        If you lose it, rotate the key.
      </p>
    </div>
  );
}
