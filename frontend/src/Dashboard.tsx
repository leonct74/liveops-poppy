// The dashboard: players, sessions, retention, events — and what it costs.
//
// Charts are plain divs on purpose. A charting library would be the biggest dependency in
// the whole poppy, and everything here is a bar or a percentage.

import { useCallback, useEffect, useState } from "react";
import type { Api } from "./api";
import type { Overview, RetentionPoint } from "./types";

const RANGES = [7, 30, 90];

export function Dashboard({ api, titleId }: { api: Api; titleId: string }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Overview | null>(null);
  const [cohorts, setCohorts] = useState<RetentionPoint[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [overview, ret] = await Promise.all([api.stats(titleId, days), api.retention(titleId, days)]);
      setData(overview);
      setCohorts(ret.cohorts);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, titleId, days]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error) {
    return (
      <div className="card">
        <div className="banner err">{error}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="card">
        <div className="skeleton" style={{ height: 72, borderRadius: 8 }} />
      </div>
    );
  }

  const peak = Math.max(1, ...data.days.map((d) => d.dau));
  const avgRetention = averageRetention(cohorts);

  return (
    <>
      <div className="card">
        <div className="spread">
          <div className="section-title" style={{ marginBottom: 0 }}>
            Players
          </div>
          <div className="tabs">
            {RANGES.map((r) => (
              <button key={r} className={`tab ${days === r ? "active" : ""}`} onClick={() => setDays(r)}>
                {r}d
              </button>
            ))}
          </div>
        </div>

        <div className="tiles" style={{ marginTop: 12 }}>
          <div className="tile">
            <div className="n">{data.totals.dau.toLocaleString()}</div>
            <div className="l">Players today</div>
          </div>
          <div className="tile">
            <div className="n">{data.totals.sessions.toLocaleString()}</div>
            <div className="l">Sessions ({days}d)</div>
          </div>
          <div className="tile">
            <div className="n">{formatDuration(data.totals.avgSessionSeconds)}</div>
            <div className="l">Avg session</div>
          </div>
          <div className="tile">
            <div className="n">{avgRetention.d1 === null ? "—" : `${avgRetention.d1}%`}</div>
            <div className="l">Day-1 retention</div>
          </div>
        </div>

        <div className="bars" aria-label="Daily active players">
          {data.days.map((d) => (
            <div
              key={d.day}
              className="bar"
              style={{ height: `${Math.max(2, (d.dau / peak) * 100)}%` }}
              title={`${d.day}: ${d.dau.toLocaleString()} players`}
            />
          ))}
        </div>
        <div className="spread muted" style={{ fontSize: 12, marginTop: 4 }}>
          <span>{data.days[0]?.day}</span>
          <span>{data.days[data.days.length - 1]?.day}</span>
        </div>
      </div>

      <div className="card">
        <div className="section-title">Retention</div>
        {cohorts.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            Retention appears once players have been coming back for a day or more.
          </p>
        ) : (
          <div className="tiles" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
            {(["d1", "d7", "d30"] as const).map((k) => (
              <div className="tile" key={k}>
                <div className="n">{avgRetention[k] === null ? "—" : `${avgRetention[k]}%`}</div>
                <div className="l">Day {k.slice(1)}</div>
              </div>
            ))}
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, marginBottom: 0, marginTop: 10 }}>
          Share of each day's new players who came back on that day. Cohorts too young to
          have reached a milestone are left out rather than counted as zero.
        </p>
      </div>

      <div className="card">
        <div className="section-title">Events</div>
        {data.events.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            No custom events yet. Call <span className="chip">LiveOps.Track("level_complete")</span> in
            your game and they show up here.
          </p>
        ) : (
          <Breakdown rows={data.events} />
        )}
        {data.eventOverflow && (
          <div className="banner info" style={{ marginTop: 10 }}>
            Some event names went into an <span className="chip">__other</span> bucket because this
            title hit its distinct-name limit for the day. That limit exists so a flood of made-up
            names can't bloat your table — raise it in Titles if your game really does send that many.
          </div>
        )}
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="section-title">Platforms</div>
          <Breakdown rows={data.platforms} />
        </div>
        <div className="card">
          <div className="section-title">Versions</div>
          <Breakdown rows={data.versions} />
        </div>
      </div>

      <div className="card">
        <div className="section-title">What this costs</div>
        <div className="row">
          <span className="n" style={{ fontSize: 20, fontWeight: 650 }}>
            ~${data.cost.estimatedUsd.toFixed(2)}
          </span>
          <span className="muted">
            for {data.cost.events.toLocaleString()} events over {days} days
          </span>
        </div>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0, marginTop: 8 }}>
          {data.cost.basis}
        </p>
      </div>
    </>
  );
}

function Breakdown({ rows }: { rows: { name: string; count: number }[] }) {
  const total = Math.max(1, rows.reduce((a, r) => a + r.count, 0));
  return (
    <div className="brk">
      {rows.slice(0, 8).map((r) => (
        <Row key={r.name} name={r.name} count={r.count} pct={(r.count / total) * 100} />
      ))}
    </div>
  );
}

function Row({ name, count, pct }: { name: string; count: number; pct: number }) {
  return (
    <>
      <span className="mono">{name}</span>
      <span className="muted">{count.toLocaleString()}</span>
      <span className="track">
        <span className="fill" style={{ width: `${pct}%` }} />
      </span>
    </>
  );
}

/** Weighted average across cohorts. Returns null for a milestone no cohort has reached
 *  yet — showing 0% for "day 30" on a two-week-old game would be a lie. */
export function averageRetention(cohorts: RetentionPoint[]): {
  d1: number | null;
  d7: number | null;
  d30: number | null;
} {
  const pick = (key: "d1" | "d7" | "d30", minAgeDays: number) => {
    const eligible = cohorts.filter((c) => c.size > 0 && ageInDays(c.cohortDay) >= minAgeDays);
    if (eligible.length === 0) return null;
    const returned = eligible.reduce((a, c) => a + c[key], 0);
    const size = eligible.reduce((a, c) => a + c.size, 0);
    return size > 0 ? Math.round((returned / size) * 100) : null;
  };
  return { d1: pick("d1", 1), d7: pick("d7", 7), d30: pick("d30", 30) };
}

function ageInDays(day: string): number {
  return Math.floor((Date.now() - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
