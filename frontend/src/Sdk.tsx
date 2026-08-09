// "Get it into my game" — the export tab. One generated C# file for Unity, or plain curl
// for every other engine.

import { useState } from "react";
import { CopyButton } from "./CopyButton";
import { restSnippets, unitySdkSource } from "./sdkSource";

type Mode = "unity" | "rest";

export function Sdk({ endpoint, titleId }: { endpoint: string | undefined; titleId: string }) {
  const [mode, setMode] = useState<Mode>("unity");

  if (!endpoint) {
    return (
      <div className="card">
        <div className="section-title">Get it into your game</div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Set up your backend first — the SDK needs your own endpoint baked into it, and that
          address only exists once the stack is running in your AWS account.
        </p>
      </div>
    );
  }

  const source = unitySdkSource({ endpoint, titleId });
  const rest = restSnippets({ endpoint, titleId });

  return (
    <div className="card">
      <div className="spread">
        <div className="section-title" style={{ marginBottom: 0 }}>
          Get it into your game
        </div>
        <div className="tabs">
          <button className={`tab ${mode === "unity" ? "active" : ""}`} onClick={() => setMode("unity")}>
            Unity
          </button>
          <button className={`tab ${mode === "rest" ? "active" : ""}`} onClick={() => setMode("rest")}>
            Any engine
          </button>
        </div>
      </div>

      {mode === "unity" ? (
        <>
          <p className="muted" style={{ fontSize: 13 }}>
            One file, no packages. Save it as <span className="chip">LiveOps.cs</span> anywhere in
            Assets/, paste your title key at the top, then call{" "}
            <span className="chip">LiveOps.Init()</span> at startup.
          </p>
          <div className="row">
            <CopyButton text={source} label="Unity SDK" />
            <button
              className="btn btn-sm"
              onClick={() => {
                // Blob download: the webview has no filesystem access, and this is the one
                // affordance that reliably works in it.
                const url = URL.createObjectURL(new Blob([source], { type: "text/plain" }));
                const a = document.createElement("a");
                a.href = url;
                a.download = "LiveOps.cs";
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Download LiveOps.cs
            </button>
          </div>
          <pre
            className="mono"
            style={{
              maxHeight: 260,
              overflow: "auto",
              background: "var(--poppy-surface-0)",
              border: "1px solid var(--poppy-border)",
              borderRadius: 8,
              padding: 10,
              fontSize: 12,
              marginTop: 10,
            }}
          >
            {source.slice(0, 1400)}
            {"\n…"}
          </pre>
        </>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 13 }}>
            Two endpoints, plain HTTPS. Unreal, Godot, or your own engine — no SDK required.
          </p>
          {[
            { title: "Read your config", code: rest.config, label: "config request" },
            { title: "Send events", code: rest.events, label: "events request" },
          ].map((block) => (
            <div key={block.title} style={{ marginTop: 12 }}>
              <div className="spread">
                <strong style={{ fontSize: 13 }}>{block.title}</strong>
                <CopyButton text={block.code} label={block.label} />
              </div>
              <pre
                className="mono"
                style={{
                  overflow: "auto",
                  background: "var(--poppy-surface-0)",
                  border: "1px solid var(--poppy-border)",
                  borderRadius: 8,
                  padding: 10,
                  fontSize: 12,
                }}
              >
                {block.code}
              </pre>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
