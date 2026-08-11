// A fully in-memory Api: what the poppy looks like with a real game running, before the
// user has deployed anything (and with no AWS account at all).
//
// This is deliberate product surface, not a test fixture: MailPoppy's demo inbox proved
// that letting someone SEE the thing working is what carries them over the setup step.
// The store listing's screenshots come from here too, so it must look like a real game.

import type { Api } from "./api";
import type { ConfigVersion, ConfigView, DeploymentStatus, Env, Overview, RetentionPoint, Title } from "./types";

const DAY_MS = 86_400_000;
const day = (offset: number, now: number) => new Date(now - offset * DAY_MS).toISOString().slice(0, 10);

/** Deterministic pseudo-random so the demo looks alive but never jitters between renders. */
function wobble(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

const DEMO_TITLE: Title = {
  titleId: "demo1234",
  name: "Sunken Keep (demo)",
  createdAt: "2026-06-02T09:00:00.000Z",
  eventCap: 500_000,
  cardCap: 200,
};

const DEMO_CONFIG = `{
  "shop": {
    "starterBundlePrice": 4.99,
    "weekendSaleActive": true
  },
  "balance": {
    "shotgunDamage": 34,
    "bossHealthMultiplier": 1.15
  },
  "features": {
    "newTutorial": true,
    "seasonalEvent": false
  }
}`;

export function demoApi(nowMs: () => number = Date.now): Api {
  const now = nowMs();
  const configs: Record<Env, ConfigView> = {
    prod: { env: "prod", version: 7, json: DEMO_CONFIG, publishedAt: new Date(now - 2 * DAY_MS).toISOString(), note: "weekend sale on" },
    dev: { env: "dev", version: 2, json: DEMO_CONFIG, publishedAt: new Date(now - 5 * DAY_MS).toISOString(), note: "testing new tutorial" },
  };
  const history: ConfigVersion[] = [
    { version: 7, publishedAt: new Date(now - 2 * DAY_MS).toISOString(), note: "weekend sale on" },
    { version: 6, publishedAt: new Date(now - 6 * DAY_MS).toISOString(), note: "nerf the shotgun" },
    { version: 5, publishedAt: new Date(now - 13 * DAY_MS).toISOString(), note: "boss health +15%" },
  ];

  const overview = (days: number): Overview => {
    const rows = Array.from({ length: days }, (_, i) => {
      const offset = days - 1 - i;
      const base = 900 + Math.round(wobble(offset + 1) * 400) + (days - offset) * 12;
      const sessions = Math.round(base * 1.8);
      return {
        day: day(offset, now),
        dau: base,
        sessions,
        sessionSeconds: sessions * (420 + Math.round(wobble(offset + 7) * 240)),
        events: sessions * 26,
      };
    });
    const totalSessions = rows.reduce((a, r) => a + r.sessions, 0);
    const totalSeconds = rows.reduce((a, r) => a + r.sessionSeconds, 0);
    const totalEvents = rows.reduce((a, r) => a + r.events, 0);
    return {
      days: rows,
      totals: {
        dau: rows[rows.length - 1]?.dau ?? 0,
        sessions: totalSessions,
        events: totalEvents,
        avgSessionSeconds: Math.round(totalSeconds / totalSessions),
      },
      platforms: [
        { name: "android", count: Math.round(totalSessions * 0.48) },
        { name: "ios", count: Math.round(totalSessions * 0.37) },
        { name: "windows", count: Math.round(totalSessions * 0.15) },
      ],
      versions: [
        { name: "1.4.2", count: Math.round(totalSessions * 0.71) },
        { name: "1.4.1", count: Math.round(totalSessions * 0.24) },
        { name: "1.3.9", count: Math.round(totalSessions * 0.05) },
      ],
      events: [
        { name: "level_complete", count: Math.round(totalEvents * 0.31) },
        { name: "level_fail", count: Math.round(totalEvents * 0.22) },
        { name: "shop_open", count: Math.round(totalEvents * 0.14) },
        { name: "purchase", count: Math.round(totalEvents * 0.03) },
        { name: "tutorial_done", count: Math.round(totalEvents * 0.02) },
      ],
      eventOverflow: false,
      cost: {
        events: totalEvents,
        estimatedUsd: Math.round((totalEvents * 2) / 1_000_000 * 1.25 * 100) / 100,
        basis:
          "Estimated from the events this deployment actually recorded, at AWS on-demand list prices. " +
          "It is an estimate, not your bill — AWS is the only authority on what you owe.",
        // Demo data never pretends to have asked AWS anything — and must not show the
        // "couldn't reach the price list" notice, which would report a failure that never
        // happened.
        prices: {
          writesPerMillionUsd: 1.25,
          requestsPerMillionUsd: 0.2,
          source: "demo",
          region: "eu-west-1",
        },
      },
    };
  };

  const retention = (days: number): RetentionPoint[] =>
    Array.from({ length: Math.min(days, 21) }, (_, i) => {
      const offset = days - 1 - i;
      const size = 260 + Math.round(wobble(offset + 3) * 120);
      return {
        cohortDay: day(offset, now),
        size,
        d1: Math.round(size * (0.38 + wobble(offset + 11) * 0.06)),
        d7: Math.round(size * (0.17 + wobble(offset + 13) * 0.04)),
        d30: Math.round(size * (0.08 + wobble(offset + 17) * 0.02)),
      };
    }).reverse();

  const notLive = async (): Promise<never> => {
    throw new Error("This is the demo. Deploy your backend to make changes for real.");
  };

  return {
    async status(): Promise<DeploymentStatus> {
      return {
        phase: "none",
        stackName: "LiveOpsPoppyStack",
        region: "—",
        inProgress: false,
        currentTemplateKey: "demo",
        currentRevision: 1,
        updateAvailable: false,
        appOutdated: false,
      };
    },
    deploy: notLive,
    teardown: notLive,
    async listTitles() {
      return { titles: [DEMO_TITLE] };
    },
    createTitle: notLive,
    removeTitle: notLive,
    rotateKey: notLive,
    setCaps: notLive,
    async getConfig(_id, env) {
      return configs[env];
    },
    async configHistory() {
      return { versions: history };
    },
    publishConfig: notLive,
    rollbackConfig: notLive,
    async stats(_id, days) {
      return overview(days);
    },
    async retention(_id, days) {
      return { cohorts: retention(days) };
    },
    erasePlayer: notLive,

    // The team dashboard is a real deployment's feature: on demo data it reads as
    // "not set up", and every mutating call refuses like the rest of demo mode.
    async teamStatus() {
      return { enabled: false };
    },
    enableTeam: notLive,
    disableTeam: notLive,
    inviteViewer: notLive,
    removeViewer: notLive,
  };
}
