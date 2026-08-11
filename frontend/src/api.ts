// Calls to our own backend, proxied by the host (capability: backend:invoke). The
// frontend has no AWS SDK, no Node and no network of its own — everything privileged goes
// through the bridge.

import { host } from "./host";
import type { ConfigVersion, ConfigView, CreatedTitle, DeploymentStatus, Env, Overview, RetentionPoint, Title } from "./types";

const t = (id: string) => encodeURIComponent(id);

export interface Api {
  status(): Promise<DeploymentStatus>;
  deploy(): Promise<{ operation: string; stackName: string }>;
  teardown(): Promise<{ ok: true; removed: string[] }>;
  listTitles(): Promise<{ titles: Title[] }>;
  createTitle(name: string): Promise<CreatedTitle>;
  removeTitle(id: string): Promise<{ ok: true }>;
  rotateKey(id: string): Promise<{ key: string; previousKeyValidUntil: string }>;
  setCaps(id: string, caps: { eventCap?: number; cardCap?: number }): Promise<Title>;
  getConfig(id: string, env: Env): Promise<ConfigView>;
  configHistory(id: string, env: Env): Promise<{ versions: ConfigVersion[] }>;
  publishConfig(id: string, env: Env, json: string, note: string): Promise<ConfigView>;
  rollbackConfig(id: string, env: Env, version: number): Promise<ConfigView>;
  stats(id: string, days: number): Promise<Overview>;
  retention(id: string, days: number): Promise<{ cohorts: RetentionPoint[] }>;
  erasePlayer(id: string, installId: string): Promise<{ playerHash: string; playerRowDeleted: boolean; note: string }>;

  // ── Team dashboard (premium) ─────────────────────────────────────────────────────────
  teamStatus(): Promise<TeamStatus>;
  enableTeam(): Promise<{ operation: string }>;
  disableTeam(): Promise<{ operation: string }>;
  inviteViewer(email: string): Promise<{ email: string; status: string }>;
  removeViewer(email: string): Promise<{ ok: true }>;
}

export interface TeamViewer {
  email: string;
  status: "invited" | "active" | "disabled" | "unknown";
  createdAt?: string;
}

export interface TeamStatus {
  enabled: boolean;
  dashboardUrl?: string;
  userPoolId?: string;
  viewers?: TeamViewer[];
}

export const api: Api = {
  status: () => host.invokeBackend({ method: "GET", path: "/status" }),
  deploy: () => host.invokeBackend({ method: "POST", path: "/deploy" }),
  /** Teardown waits for CloudFormation to finish deleting — well past the default timeout. */
  teardown: () => host.invokeBackend({ method: "POST", path: "/teardown" }, 15 * 60_000),

  listTitles: () => host.invokeBackend({ method: "GET", path: "/titles" }),
  createTitle: (name) => host.invokeBackend({ method: "POST", path: "/titles", body: { name } }),
  removeTitle: (id) => host.invokeBackend({ method: "DELETE", path: `/titles/${t(id)}` }),
  rotateKey: (id) => host.invokeBackend({ method: "POST", path: `/titles/${t(id)}/rotate-key` }),
  setCaps: (id, caps) => host.invokeBackend({ method: "POST", path: `/titles/${t(id)}/caps`, body: caps }),

  getConfig: (id, env) => host.invokeBackend({ method: "GET", path: `/titles/${t(id)}/config/${env}` }),
  configHistory: (id, env) =>
    host.invokeBackend({ method: "GET", path: `/titles/${t(id)}/config/${env}/history` }),
  publishConfig: (id, env, json, note) =>
    host.invokeBackend({ method: "POST", path: `/titles/${t(id)}/config/${env}`, body: { json, note } }),
  rollbackConfig: (id, env, version) =>
    host.invokeBackend({ method: "POST", path: `/titles/${t(id)}/config/${env}/rollback`, body: { version } }),

  stats: (id, days) => host.invokeBackend({ method: "GET", path: `/titles/${t(id)}/stats?days=${days}` }),
  retention: (id, days) =>
    host.invokeBackend({ method: "GET", path: `/titles/${t(id)}/retention?days=${days}` }),
  erasePlayer: (id, installId) =>
    host.invokeBackend({ method: "POST", path: `/titles/${t(id)}/erase-player`, body: { installId } }),

  teamStatus: () => host.invokeBackend({ method: "GET", path: "/team" }),
  // Both of these redeploy the stack, which takes minutes — same budget as /deploy.
  enableTeam: () => host.invokeBackend({ method: "POST", path: "/team/enable" }, 5 * 60_000),
  disableTeam: () => host.invokeBackend({ method: "POST", path: "/team/disable" }, 5 * 60_000),
  inviteViewer: (email) => host.invokeBackend({ method: "POST", path: "/team/viewers", body: { email } }),
  removeViewer: (email) =>
    host.invokeBackend({ method: "DELETE", path: `/team/viewers/${encodeURIComponent(email)}` }),
};
