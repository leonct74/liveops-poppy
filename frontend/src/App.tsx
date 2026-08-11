// The poppy shell.
//
// Before anything is deployed the app runs on the DEMO api — a fake studio with plausible
// numbers — so a developer can see exactly what they'd get before opening an AWS account.
// That is deliberate product surface, not a placeholder (MailPoppy's demo inbox proved it
// is what carries people over the setup step).

import { useEffect, useMemo, useState } from "react";
import { api as liveApi, type Api } from "./api";
import { demoApi } from "./demo";
import { Dashboard } from "./Dashboard";
import { ConfigEditor } from "./ConfigEditor";
import { Deployment } from "./Deployment";
import { Sdk } from "./Sdk";
import { Titles } from "./Titles";
import { Team } from "./Team";
import type { DeploymentStatus } from "./types";
import { Feedback } from "./Feedback";

type Tab = "dashboard" | "config" | "titles" | "team" | "setup" | "feedback";

// Feedback is LAST in every poppy (AGENTS.md §9a) — same place in all of them.
const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "config", label: "Remote config" },
  { id: "titles", label: "Titles & SDK" },
  { id: "team", label: "Team" },
  { id: "setup", label: "Setup" },
  { id: "feedback", label: "Feedback" },
];

/**
 * ?screen=<tab> picks the landing tab — how the listing screenshots are captured
 * headlessly (each tab is URL-addressable), and a plain deep link for docs.
 * Unknown or absent → dashboard, same as before.
 */
function initialTab(): Tab {
  try {
    const t = new URLSearchParams(window.location.search).get("screen");
    return TABS.some((x) => x.id === t) ? (t as Tab) : "dashboard";
  } catch {
    return "dashboard";
  }
}

export function App({ apiImpl, statusPollMs = 10_000 }: { apiImpl?: Api; statusPollMs?: number } = {}) {
  const live = apiImpl ?? liveApi;
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [titleId, setTitleId] = useState<string>("");

  // "Deployed" is read from AWS, never remembered — so this flips on its own the moment
  // the stack goes live, without the user hunting for a refresh button.
  const isLive = status?.phase === "ready";
  const demo = useMemo(() => demoApi(), []);
  const active: Api = isLive ? live : demo;

  // The shell asks for status ITSELF rather than waiting for the Setup tab's panel to
  // report in: otherwise someone with a live deployment opens the app, sees "demo data",
  // and has to find the Setup tab before the app admits their backend exists.
  //
  // And it KEEPS asking until the answer is "ready": the Setup panel only polls while
  // mounted, so someone who starts a deploy and then browses the other tabs (which is
  // what a two-minute wait invites) would otherwise stay on "demo data" forever — the
  // stack completes and nothing in the app ever hears it (founder field report,
  // 2026-08-11). Once live, the polling stops; Setup's own panel covers the rest.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const probe = async () => {
      try {
        const s = await live.status();
        if (cancelled) return;
        setStatus(s);
        if (s.phase === "ready") return; // live now — stop asking
      } catch {
        // No connection yet, or the backend isn't reachable — demo mode is the honest
        // fallback, and the Setup tab surfaces the actual error.
      }
      if (!cancelled) timer = window.setTimeout(() => void probe(), statusPollMs);
    };
    void probe();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [live, statusPollMs]);

  useEffect(() => {
    // Switching between demo and live changes which titles exist.
    setTitleId("");
  }, [isLive]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { titles } = await active.listTitles();
        if (!cancelled && titles[0]) setTitleId((current) => current || titles[0]!.titleId);
      } catch {
        /* the panels surface their own errors */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  return (
    <div className="app">
      <header className="app-header">
        <img src="./liveopspoppy-icon.png" alt="" />
        <h1>LiveOpsPoppy</h1>
      </header>
      <p className="app-sub">
        Your game's LiveOps backend, in your own AWS. Change balance, prices and features
        live — no store review — and see players, sessions and retention. No per-player fees.
      </p>

      {!isLive && (
        <div className="banner info" style={{ marginBottom: 14 }}>
          <strong>You're looking at demo data.</strong> This is a made-up game so you can see
          what LiveOpsPoppy does. Set it up in your own AWS account (Setup tab) and it switches
          to your real titles — nothing here is sent anywhere.
        </div>
      )}

      {/* The tabs are ordered for the hundredth visit (Dashboard first), but the FIRST
          visit flows Setup → Titles → Config — right to left. So at each stage the app
          says what comes next instead of leaving the user to guess (founder field
          report, 2026-08-11: "create a title" meant nothing and nothing pointed there). */}
      {isLive && !titleId && (
        <div className="banner info" style={{ marginBottom: 14 }}>
          <div className="spread">
            <span>
              <strong>Your backend is live.</strong> One step left: register your game — the
              industry word is a &ldquo;title&rdquo;. It gets an id, a secret-shown-once key, and
              its own daily event cap.
            </span>
            <button className="btn btn-primary btn-sm" onClick={() => setTab("titles")}>
              Create your game
            </button>
          </div>
        </div>
      )}

      <nav className="tabs" style={{ marginBottom: 14 }} aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? "active" : ""}`}
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "dashboard" &&
        (titleId ? (
          <Dashboard api={active} titleId={titleId} />
        ) : (
          <div className="card">
            <p className="muted" style={{ marginBottom: 0 }}>
              Create a title in <strong>Titles &amp; SDK</strong> to start seeing numbers here.
            </p>
          </div>
        ))}

      {tab === "config" &&
        (titleId ? (
          <ConfigEditor api={active} titleId={titleId} readOnly={!isLive} />
        ) : (
          <div className="card">
            <p className="muted" style={{ marginBottom: 0 }}>
              Create a title first — remote config belongs to a specific game.
            </p>
          </div>
        ))}

      {tab === "titles" && (
        <>
          <Titles api={active} readOnly={!isLive} selectedId={titleId} onSelect={setTitleId} />
          {titleId && <Sdk endpoint={status?.collectorUrl} titleId={titleId} />}
        </>
      )}

      {/* Entitlement is per TITLE, so the Team tab needs one selected before it can ask
          the host whether this game is paid for. */}
      {tab === "team" &&
        (titleId ? (
          <Team api={active} titleId={titleId} isLive={isLive} />
        ) : (
          <div className="card">
            <div className="section-title">Team dashboard</div>
            <p className="muted" style={{ marginBottom: 0 }}>
              Create a title first — the team dashboard is bought and shared per game.
            </p>
          </div>
        ))}

      {tab === "setup" && (
        <>
          <Deployment api={live} onChange={setStatus} />
          <div className="card">
            <div className="section-title">What this creates in your account</div>
            <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
              <li>One DynamoDB table holding your config and your counters</li>
              <li>One Lambda behind an HTTPS address your game talks to</li>
              <li>That Lambda's own least-privilege role, and its log group</li>
              <li>A small S3 bucket holding the Lambda's code</li>
            </ul>
            <p className="muted" style={{ fontSize: 13, marginBottom: 0, marginTop: 10 }}>
              Nothing else, and nothing outside names starting with <span className="chip">LiveOpsPoppy</span>.
              "Remove everything" deletes all of it.
            </p>
          </div>
        </>
      )}

      {tab === "feedback" && <Feedback />}
    </div>
  );
}
