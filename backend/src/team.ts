// The team plane's admin side (DESIGN §10) — the PREMIUM half of LiveOpsPoppy.
//
// A studio buys the team dashboard per title, then invites the people who should read the
// numbers: a producer, a designer, an investor. Those people never install AgentsPoppy and
// never touch AWS; they sign in to a web page served by the studio's own viewer Lambda.
//
// Everything here manages the Cognito pool the stack created. The Cognito client is
// injected, so every path is unit-tested without AWS.

export interface CognitoLike {
  send(command: unknown): Promise<any>;
}

export interface Viewer {
  email: string;
  /** Cognito's own status, mapped to plain words for the UI. */
  status: "invited" | "active" | "disabled" | "unknown";
  createdAt?: string;
}

export interface TeamStatus {
  /** False when the stack carries no viewer plane — the premium isn't enabled. */
  enabled: boolean;
  /** The fixed address the studio's team bookmarks. Absent when disabled. */
  dashboardUrl?: string;
  userPoolId?: string;
  viewers?: Viewer[];
}

/**
 * A viewer's email. Deliberately strict-but-simple: this address receives an invitation
 * and becomes a sign-in, so a malformed one fails later and confusingly.
 */
export const VIEWER_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function emailProblem(email: unknown): string | null {
  if (typeof email !== "string" || !email.trim()) return "An email address is required.";
  const value = email.trim();
  if (value.length > 254 || !VIEWER_EMAIL_RE.test(value)) return `"${value}" doesn't look like an email address.`;
  return null;
}

/** Cognito's UserStatus vocabulary → what an admin actually needs to understand. */
export function viewerStatus(cognitoStatus: unknown, enabled: unknown): Viewer["status"] {
  if (enabled === false) return "disabled";
  switch (cognitoStatus) {
    case "FORCE_CHANGE_PASSWORD":
    case "RESET_REQUIRED":
      return "invited";
    case "CONFIRMED":
      return "active";
    default:
      return "unknown";
  }
}

/**
 * A first-sign-in password that satisfies the pool's policy (≥10 chars, lower + digit) and
 * is never reused. The viewer is forced to change it on first sign-in, so this value only
 * has to survive the invitation.
 */
export function temporaryPassword(random: () => string): string {
  // Two random chunks plus a guaranteed digit and letter — the policy is satisfied by
  // construction rather than by hoping the random string happens to comply.
  return `Lop${random().slice(0, 10)}7a`;
}

export interface TeamDeps {
  cognito: CognitoLike;
  /** Stack outputs, so team.ts never re-implements stack lookups. */
  outputs(): Promise<Record<string, string>>;
  /** Injected for deterministic tests. */
  random?: () => string;
}

/** Read the team plane's state from the deployed stack. */
export async function getTeamStatus(deps: TeamDeps): Promise<TeamStatus> {
  const outputs = await deps.outputs();
  const userPoolId = outputs.ViewerPoolId;
  const dashboardUrl = outputs.ViewerUrl;
  // The outputs are condition-gated in the template, so their ABSENCE is the signal.
  if (!userPoolId || !dashboardUrl) return { enabled: false };
  return { enabled: true, dashboardUrl, userPoolId, viewers: await listViewers(deps, userPoolId) };
}

export async function listViewers(deps: TeamDeps, userPoolId: string): Promise<Viewer[]> {
  const { ListUsersCommand } = await import("@aws-sdk/client-cognito-identity-provider");
  const out = await deps.cognito.send(new ListUsersCommand({ UserPoolId: userPoolId, Limit: 60 }));
  return (out.Users ?? [])
    .map((u: any) => ({
      email: (u.Attributes ?? []).find((a: any) => a.Name === "email")?.Value ?? u.Username ?? "",
      status: viewerStatus(u.UserStatus, u.Enabled),
      createdAt: u.UserCreateDate ? new Date(u.UserCreateDate).toISOString() : undefined,
    }))
    .filter((v: Viewer) => v.email)
    .sort((a: Viewer, b: Viewer) => a.email.localeCompare(b.email));
}

/**
 * Invite a viewer. Cognito emails them the temporary password; they set their own on first
 * sign-in, so the admin never knows it — the same rule MailPoppy follows for mailboxes.
 */
export async function inviteViewer(
  deps: TeamDeps,
  userPoolId: string,
  email: string,
): Promise<{ email: string; status: Viewer["status"] }> {
  const problem = emailProblem(email);
  if (problem) throw new Error(problem);
  const address = email.trim().toLowerCase();

  const { AdminCreateUserCommand } = await import("@aws-sdk/client-cognito-identity-provider");
  const random = deps.random ?? (() => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
  try {
    await deps.cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: address,
        UserAttributes: [
          { Name: "email", Value: address },
          // Pre-verified: the invitation itself proves the admin knows the address, and an
          // unverified viewer couldn't use email-based password recovery.
          { Name: "email_verified", Value: "true" },
        ],
        TemporaryPassword: temporaryPassword(random),
        DesiredDeliveryMediums: ["EMAIL"],
      }),
    );
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === "UsernameExistsException") throw new Error(`${address} has already been invited.`);
    throw e;
  }
  return { email: address, status: "invited" };
}

/**
 * Remove a viewer's access. Deleting the Cognito user is immediate and total: their
 * existing tokens are ≤1 h from expiry (the pool's token validity) and cannot be renewed.
 */
export async function removeViewer(deps: TeamDeps, userPoolId: string, email: string): Promise<void> {
  const problem = emailProblem(email);
  if (problem) throw new Error(problem);
  const { AdminDeleteUserCommand } = await import("@aws-sdk/client-cognito-identity-provider");
  try {
    await deps.cognito.send(
      new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email.trim().toLowerCase() }),
    );
  } catch (e) {
    if ((e as { name?: string }).name === "UserNotFoundException") return; // already gone — fine
    throw e;
  }
}
