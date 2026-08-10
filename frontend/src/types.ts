// Wire types shared with the backend. Kept hand-written (not generated) so a backend
// change that breaks the contract shows up as a typecheck error here.

export type DeploymentPhase = "none" | "deploying" | "ready" | "removing" | "failed";

export interface DeploymentStatus {
  phase: DeploymentPhase;
  stackStatus?: string;
  stackName: string;
  region: string;
  tableName?: string;
  inProgress: boolean;
  message?: string;
  failureReason?: string;
  deployedTemplateKey?: string;
  currentTemplateKey: string;
  deployedRevision?: number;
  currentRevision: number;
  updateAvailable: boolean;
  appOutdated: boolean;
  collectorUrl?: string;
}

export interface Title {
  titleId: string;
  name: string;
  createdAt: string;
  eventCap: number;
  cardCap: number;
  previousKeyValidUntil?: string;
}

export interface CreatedTitle {
  title: Title;
  key: string;
}

export type Env = "dev" | "prod";

export interface ConfigView {
  env: Env;
  version: number;
  json: string;
  publishedAt?: string;
  note?: string;
}

export interface ConfigVersion {
  version: number;
  publishedAt: string;
  note: string;
}

export interface DayStats {
  day: string;
  dau: number;
  sessions: number;
  sessionSeconds: number;
  events: number;
}

export interface Breakdown {
  name: string;
  count: number;
}

export interface PriceBook {
  writesPerMillionUsd: number;
  requestsPerMillionUsd: number;
  /**
   * "aws" = AWS's own price list; "builtin" = our fallback, which may be out of date and is
   * flagged as such. "demo" exists only on this side: the demo dashboard never asks AWS
   * anything, so it must not claim a lookup failed.
   */
  source: "aws" | "builtin" | "demo";
  region: string;
}

export interface CostEstimate {
  events: number;
  estimatedUsd: number;
  basis: string;
  prices: PriceBook;
}

export interface Overview {
  days: DayStats[];
  totals: { dau: number; sessions: number; events: number; avgSessionSeconds: number };
  platforms: Breakdown[];
  versions: Breakdown[];
  events: Breakdown[];
  eventOverflow: boolean;
  cost: CostEstimate;
}

export interface RetentionPoint {
  cohortDay: string;
  size: number;
  d1: number;
  d7: number;
  d30: number;
}
