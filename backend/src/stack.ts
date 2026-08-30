// The stack lifecycle: deploy, report live status, tear down.
//
// The template + Lambda zip are EMBEDDED in this bundle (backend-bundle.ts, generated from
// infra/ + lambdas/), so the user never needs cdk, node, or a round-trip to a template
// store. Everything here takes its AWS clients by injection so the lifecycle logic is
// unit-testable without touching AWS.

import {
  ContinueUpdateRollbackCommand,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
  waitUntilStackDeleteComplete,
  type Capability,
  type CloudFormationClient,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  lambdaCodeKey,
  lambdaZipBase64,
  sourceCommit,
  stackName,
  tableName,
  templateJson,
  templateKey,
  templateRevision,
} from "./generated/backend-bundle";
import { deleteDeployBucket, deployBucketName, ensureDeployBucket, uploadLambdaCode } from "./deploy-bucket";
import { stackTags, type AttributionContext } from "./tags";

export { lambdaCodeKey, stackName, tableName, templateKey, templateRevision };

/** Everything the stack lifecycle needs to reach AWS. Clients injected → unit-testable. */
export interface AwsCtx {
  cfn: CloudFormationClient;
  s3: S3Client;
  region: string;
  accountId: string;
  /**
   * AgentsPoppy's `AgentsPoppyBoundary` policy ARN, from the bootstrap — set only when the
   * host has confirmed it exists in the account (boot.ts). Absent is not "no boundary": see
   * boundaryParameterValue.
   */
  permissionsBoundaryArn?: string;
}

/** The stack creates a NAMED IAM role, so CloudFormation needs this acknowledged. */
const CAPABILITIES: Capability[] = ["CAPABILITY_NAMED_IAM"];

/** How the UI should treat the stack right now — derived from AWS, never remembered. */
export type DeploymentPhase = "none" | "deploying" | "ready" | "removing" | "failed";

export interface DeploymentStatus {
  phase: DeploymentPhase;
  /** The raw CloudFormation StackStatus, for the technical/details view. */
  stackStatus?: string;
  stackName: string;
  region: string;
  tableName?: string;
  /** True while AWS is still working — the UI polls on this (AGENTS.md §5). */
  inProgress: boolean;
  /** One calm sentence for the user when something went wrong. */
  message?: string;
  /** The raw CloudFormation reason for a failure — for the technical details view. */
  failureReason?: string;
  deployedTemplateKey?: string;
  currentTemplateKey: string;
  /** The revision the deployed stack reports vs. the one this build ships. */
  deployedRevision?: number;
  currentRevision: number;
  /** True only when this build is NEWER than what's deployed (never a downgrade). */
  updateAvailable: boolean;
  /** True when the DEPLOYED stack is newer than this build — the app should update itself. */
  appOutdated: boolean;
  /** The public endpoint games talk to, once the stack is up. */
  collectorUrl?: string;
}

export type StackOperation = "CREATE" | "UPDATE" | "NO_CHANGE" | "RECREATE";

/** Tags recording WHICH build a stack runs — the NO_CHANGE cross-check. */
export const TEMPLATE_KEY_TAG = "liveopspoppy:templateKey";
export const REVISION_TAG = "liveopspoppy:templateRevision";

/** CloudFormation statuses that mean "AWS is mid-operation, poll me". */
const IN_PROGRESS = /_IN_PROGRESS$/;
/** Statuses that mean the last operation left the stack unusable. */
const FAILED = /(ROLLBACK_COMPLETE|ROLLBACK_FAILED|_FAILED)$/;

/** True when DescribeStacks says the stack simply isn't there. */
function isNotFound(e: unknown): boolean {
  const err = e as { name?: string; message?: string };
  return err?.name === "ValidationError" && /does not exist/i.test(err?.message ?? "");
}

/** The stack as AWS currently has it, or null if it doesn't exist. */
async function describe(cfn: CloudFormationClient, name: string): Promise<Stack | null> {
  try {
    const out = await cfn.send(new DescribeStacksCommand({ StackName: name }));
    return out.Stacks?.[0] ?? null;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

function phaseOf(status: string | undefined): DeploymentPhase {
  if (!status) return "none";
  if (status.startsWith("DELETE") && IN_PROGRESS.test(status)) return "removing";
  if (IN_PROGRESS.test(status)) return "deploying";
  if (FAILED.test(status)) return "failed";
  if (status === "CREATE_COMPLETE" || status === "UPDATE_COMPLETE") return "ready";
  return "deploying";
}

/**
 * Decide whether an update is on offer — ORDERING-AWARE, unlike MailPoppy's plain
 * inequality check, which let an older installed app offer to roll a NEWER backend
 * BACKWARDS (the 2026-07-29 downgrade footgun). Rules:
 *
 *  - deployed revision > ours  → the app is behind: never offer, flag appOutdated.
 *  - deployed revision < ours  → a genuine update.
 *  - same revision, different content key (template or Lambda code) → a same-revision
 *    rebuild (a code-only fix); offer it, since revision can't order it either way.
 *  - no revision recorded (stack predates the tag) → fall back to content comparison.
 *  - roles NOT capped by the boundary the host confirms RIGHT NOW → an update, even when
 *    every content key matches.
 *
 * That last rule is what stops the AgentsPoppy boundary (broker-role-v2 step 2) from being
 * applicable only as a side effect of some unrelated change. Without it: a user updates the
 * backend while their AgentsPoppy setup is still pre-boundary, so nothing is confirmed and
 * the stack lands at the current revision with UNBOUNDED roles; they later re-run setup and
 * the host starts confirming the boundary — but revision and both content keys now match,
 * so nothing ever marks their stack out of date and they stay silently uncapped forever.
 * Honest in the other direction too: when the host confirms nothing there is genuinely
 * nothing to apply, so this stays quiet rather than nagging about an update we can't make.
 */
export function compareDeployment(deployed: {
  revision?: number;
  templateKey?: string;
  codeKey?: string;
  /**
   * The stack's deployed `PermissionsBoundaryArn` parameter — `""` when its roles are
   * uncapped. Pass this ONLY when a stack exists: `undefined` means "nothing deployed",
   * and a stack that doesn't exist has no roles to cap.
   */
  boundaryArn?: string;
  /** The boundary ARN the host confirms right now (`AwsCtx.permissionsBoundaryArn`). */
  confirmedBoundaryArn?: string;
}): { updateAvailable: boolean; appOutdated: boolean } {
  const { revision, templateKey: dTemplate, codeKey: dCode, boundaryArn, confirmedBoundaryArn } = deployed;
  if (revision !== undefined && revision > templateRevision) {
    // The app is behind: deploying from here would roll the backend BACKWARDS, so not even
    // the boundary is worth offering — the app has to update first (deploy() refuses too).
    return { updateAvailable: false, appOutdated: true };
  }
  // An existing stack whose roles aren't capped by the boundary the host now confirms is
  // out of date whatever the content keys say.
  const boundaryPending =
    !!confirmedBoundaryArn && boundaryArn !== undefined && boundaryArn !== confirmedBoundaryArn;
  if (revision !== undefined && revision < templateRevision) {
    return { updateAvailable: true, appOutdated: false };
  }
  // Same revision (or none recorded): the content keys are the only signal left. A stack
  // with no keys at all predates both tags — say nothing rather than nag about an update
  // we cannot substantiate.
  const contentDiffers =
    (!!dTemplate && dTemplate !== templateKey) || (!!dCode && dCode !== lambdaCodeKey);
  return { updateAvailable: contentDiffers || boundaryPending, appOutdated: false };
}

/**
 * Read the live deployment state straight from CloudFormation.
 *
 * This is the whole of AGENTS.md §5: the UI holds no memory of a deploy. It calls this on
 * every mount and derives where the user is from what's really in their account, so
 * leaving mid-deploy and coming back lands on live progress rather than a dead spinner.
 */
export async function getStatus(ctx: AwsCtx): Promise<DeploymentStatus> {
  const { cfn, region } = ctx;
  const stack = await describe(cfn, stackName);
  const stackStatus = stack?.StackStatus;
  const phase = phaseOf(stackStatus);
  const tag = (key: string) => stack?.Tags?.find((t) => t.Key === key)?.Value;
  const deployedTemplateKey = tag(TEMPLATE_KEY_TAG);
  const rawRevision = tag(REVISION_TAG);
  const deployedRevision = rawRevision !== undefined ? Number(rawRevision) : undefined;
  // The deployed collector-code key rides as a stack PARAMETER — a code-only change moves
  // it while the template key stays put, so the comparison must watch both.
  const deployedCodeKey = stack?.Parameters?.find((p) => p.ParameterKey === "LambdaCodeKey")?.ParameterValue;
  // The boundary the deployed roles actually carry. Read ONLY when a stack exists: its
  // absence is how compareDeployment tells "uncapped roles" from "no roles at all". A stack
  // deployed before the parameter existed reads as "" — uncapped, which is the truth.
  const deployedBoundaryArn = stack
    ? (stack.Parameters?.find((p) => p.ParameterKey === "PermissionsBoundaryArn")?.ParameterValue ?? "")
    : undefined;
  const collectorUrl = stack?.Outputs?.find((o) => o.OutputKey === "CollectorUrl")?.OutputValue;

  // On a failure, pull the actual reason from the stack's events so the details view shows
  // WHY (e.g. an AccessDenied on a specific action), not just "it rolled back". Best-effort
  // and read-only — a permission gap here must never mask the failure itself.
  const failureReason = phase === "failed" ? await firstFailureReason(cfn) : undefined;

  const { updateAvailable, appOutdated } = compareDeployment({
    ...(deployedRevision !== undefined && Number.isFinite(deployedRevision)
      ? { revision: deployedRevision }
      : {}),
    ...(deployedTemplateKey ? { templateKey: deployedTemplateKey } : {}),
    ...(deployedCodeKey ? { codeKey: deployedCodeKey } : {}),
    ...(deployedBoundaryArn !== undefined ? { boundaryArn: deployedBoundaryArn } : {}),
    ...(ctx.permissionsBoundaryArn ? { confirmedBoundaryArn: ctx.permissionsBoundaryArn } : {}),
  });

  return {
    phase,
    stackStatus,
    stackName,
    region,
    tableName: phase === "ready" ? tableName : undefined,
    inProgress: !!stackStatus && IN_PROGRESS.test(stackStatus),
    message: phase === "failed" ? failureMessage(stackStatus) : undefined,
    failureReason,
    deployedTemplateKey,
    currentTemplateKey: templateKey,
    deployedRevision,
    currentRevision: templateRevision,
    updateAvailable,
    appOutdated,
    collectorUrl: phase === "ready" ? collectorUrl : undefined,
  };
}

/**
 * The raw reason CloudFormation gives for the first resource that failed — the
 * root-cause event, which the later CREATE_FAILED/ROLLBACK noise buries. Read-only,
 * best-effort: any error (throttling, a missing DescribeStackEvents grant) yields
 * undefined rather than masking the failure the user is already looking at.
 */
async function firstFailureReason(cfn: CloudFormationClient): Promise<string | undefined> {
  try {
    const out = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName }));
    // Events are newest-first; the earliest *_FAILED with a reason is the trigger. Ignore
    // the boilerplate rollback reason CloudFormation stamps on the stack itself.
    const failures = (out.StackEvents ?? []).filter(
      (e) =>
        e.ResourceStatus?.endsWith("_FAILED") &&
        e.ResourceStatusReason &&
        !/resource creation cancelled/i.test(e.ResourceStatusReason),
    );
    return failures[failures.length - 1]?.ResourceStatusReason;
  } catch {
    return undefined;
  }
}

function failureMessage(status: string | undefined): string {
  if (status === "ROLLBACK_COMPLETE" || status === "ROLLBACK_FAILED") {
    return "The last setup attempt didn't finish and AWS undid it. You can safely try again.";
  }
  return "Something went wrong in your AWS account during the last change. You can try again, or remove LiveOpsPoppy and start fresh.";
}

export interface DeployResult {
  operation: StackOperation;
  stackName: string;
  templateKey: string;
  revision: number;
}

/**
 * Create or update the stack. Returns as soon as AWS accepts the request — the work runs
 * in the background (AGENTS.md §5); poll getStatus for completion.
 *
 * Before deploying we ensure the per-account deploy bucket exists and upload the
 * collector's code zip to it (content-addressed key), then point the stack at it.
 */
/**
 * Every stack Output as a plain map. The team plane's outputs are condition-gated, so their
 * ABSENCE is how the admin plane knows the premium dashboard isn't enabled.
 */
export async function stackOutputs(ctx: Pick<AwsCtx, "cfn">): Promise<Record<string, string>> {
  const stack = await describe(ctx.cfn, stackName);
  const out: Record<string, string> = {};
  for (const o of stack?.Outputs ?? []) {
    if (o.OutputKey && o.OutputValue) out[o.OutputKey] = o.OutputValue;
  }
  return out;
}

/**
 * The value to deploy the stack's `PermissionsBoundaryArn` parameter with — the AgentsPoppy
 * ceiling on every IAM role the stack creates (broker-role-v2 step 2). Pure: `before` is the
 * DescribeStacks result the deploy path already holds, so this costs no extra AWS call.
 *
 * Fail-safe in BOTH directions, which is why "absent" is not the same as "empty":
 *  - the host CONFIRMED the boundary policy exists → use it. Naming it only when confirmed
 *    is what stops CreateRole failing on a policy that isn't in the account;
 *  - not confirmed → PRESERVE whatever the deployed stack already carries. Absence also
 *    covers a transient host-side read, and a routine update must never strip an applied
 *    boundary because of a hiccup;
 *  - nothing deployed yet → empty, i.e. unbounded. The only value that works on a fresh
 *    create against a pre-boundary AgentsPoppy setup;
 *  - a DEAD stack (ROLLBACK_COMPLETE / REVIEW_IN_PROGRESS — the two the deploy below
 *    deletes and recreates) → empty. It has no live roles left to protect, so preserving
 *    buys no safety, while carrying an UNCONFIRMED ARN into the fresh CreateRole is how one
 *    boundary-caused rollback becomes self-perpetuating: the create fails, the new
 *    ROLLBACK_COMPLETE records the bad ARN again, the user retries, it fails again.
 *
 * `before` is read BEFORE any of this is computed, so the status is always known here.
 */
export function boundaryParameterValue(confirmed: string | undefined, before: Stack | null): string {
  // A host-confirmed ARN still applies normally, dead stack or not: it has been checked to
  // exist in the account, so it can't be the thing that fails the create.
  if (confirmed) return confirmed;
  const status = before?.StackStatus;
  if (status === "ROLLBACK_COMPLETE" || status === "REVIEW_IN_PROGRESS") return "";
  return (
    before?.Parameters?.find((p) => p.ParameterKey === "PermissionsBoundaryArn")?.ParameterValue ?? ""
  );
}

export async function deploy(
  ctx: AwsCtx,
  attribution: AttributionContext,
  /**
   * Premium team dashboard (DESIGN §10). Carried through as a stack parameter so the free
   * path creates none of it. Undefined = keep whatever the stack already has, so an ordinary
   * "update backend" can never silently switch a studio's dashboard off (or on).
   */
  teamDashboard?: boolean,
): Promise<DeployResult> {
  const { cfn, s3, region, accountId, permissionsBoundaryArn } = ctx;
  // The stack MUST carry attribution or AgentsPoppy can neither show nor tear down what
  // we made — so refuse rather than deploy an untrackable footprint.
  if (!attribution.accountId || !attribution.connectionId) {
    throw new Error(
      "LiveOpsPoppy isn't connected to your AWS account yet. Approve it in AgentsPoppy, then try again.",
    );
  }

  // Refuse to roll a NEWER deployed stack backwards. The status route reports appOutdated
  // so the UI can say "update LiveOpsPoppy first", but a direct POST must be refused too —
  // the guard belongs on the mutating path, not only in the UI.
  // describe() returns null ONLY for a positive "does not exist"; every other failure — a
  // throttle, a dropped connection, an expired credential — throws. That distinction is
  // load-bearing: answering "no stack" to a read we could not make would hand CloudFormation
  // an empty PermissionsBoundaryArn and silently STRIP the cap off every role it created. So
  // stop before changing anything, and say why in words the user can act on.
  let before: Stack | null;
  try {
    before = await describe(cfn, stackName);
  } catch (e) {
    throw new Error(
      `Couldn't read your LiveOpsPoppy stack from AWS, so nothing was changed — continuing blind could remove the security limits on the roles it created. Try again in a moment. (${(e as Error).message})`,
    );
  }
  const beforeRevision = Number(before?.Tags?.find((t) => t.Key === REVISION_TAG)?.Value);
  if (Number.isFinite(beforeRevision) && beforeRevision > templateRevision) {
    throw new Error(
      `Your deployed backend (revision ${beforeRevision}) is newer than this version of LiveOpsPoppy (revision ${templateRevision}). Update the app first — deploying now would roll your backend backwards.`,
    );
  }

  const attrTags = stackTags({ ...attribution, ...(sourceCommit ? { sourceCommit } : {}) });
  const Tags = [
    ...attrTags,
    { Key: TEMPLATE_KEY_TAG, Value: templateKey },
    { Key: REVISION_TAG, Value: String(templateRevision) },
  ];

  // The deploy bucket is our one out-of-stack resource — tag it as ours so it's swept up,
  // and upload the code the stack will reference.
  const bucket = deployBucketName(accountId, region);
  await ensureDeployBucket(s3, bucket, region, attrTags);
  await uploadLambdaCode(s3, bucket, lambdaCodeKey, lambdaZipBase64);

  // On an UPDATE, leaving a parameter out would reset it to the template default ("no"),
  // which would delete a paying studio's dashboard as a side effect of a routine update.
  // So: an explicit choice wins; otherwise reuse what the stack already has; and on a
  // first create there is nothing to reuse, so fall back to off.
  const deployedTeam = before?.Parameters?.find((p) => p.ParameterKey === "TeamDashboardEnabled")?.ParameterValue;
  const teamValue = teamDashboard === undefined ? (deployedTeam ?? "no") : teamDashboard ? "yes" : "no";

  const args = {
    StackName: stackName,
    TemplateBody: templateJson,
    Parameters: [
      { ParameterKey: "LambdaCodeBucket", ParameterValue: bucket },
      { ParameterKey: "LambdaCodeKey", ParameterValue: lambdaCodeKey },
      { ParameterKey: "TeamDashboardEnabled", ParameterValue: teamValue },
      // The viewer pool is born tagged from these rather than relying on stack-tag
      // propagation (TrafficPoppy's P5 proved it is not universal). A pool's ARN carries a
      // random id, so its grant can only be tag-scoped: these are load-bearing.
      { ParameterKey: "AttrAccountId", ParameterValue: attribution.accountId },
      { ParameterKey: "AttrConnectionId", ParameterValue: attribution.connectionId },
      // Not a user choice — the platform's cap on the roles this stack creates, resolved
      // from the bootstrap and what's already deployed. Always an explicit value, never
      // UsePreviousValue: that fails outright on the first update after a template gains
      // a parameter, which is exactly what this one is to every existing stack.
      {
        ParameterKey: "PermissionsBoundaryArn",
        ParameterValue: boundaryParameterValue(permissionsBoundaryArn, before),
      },
    ],
    Capabilities: CAPABILITIES,
    Tags,
  };

  const status = before?.StackStatus;

  // A previous failed create leaves ROLLBACK_COMPLETE: it can't be updated, and creating
  // over it fails until it's fully gone. Delete, wait, recreate.
  if (status === "ROLLBACK_COMPLETE" || status === "REVIEW_IN_PROGRESS") {
    await cfn.send(new DeleteStackCommand({ StackName: stackName }));
    await waitUntilStackDeleteComplete({ client: cfn, maxWaitTime: 300 }, { StackName: stackName });
    await cfn.send(new CreateStackCommand(args));
    return { operation: "RECREATE", stackName, templateKey, revision: templateRevision };
  }

  if (!status) {
    await cfn.send(new CreateStackCommand(args));
    return { operation: "CREATE", stackName, templateKey, revision: templateRevision };
  }

  // A failed update whose rollback ALSO failed strands the stack: it can only leave
  // UPDATE_ROLLBACK_FAILED via ContinueUpdateRollback — or a delete, which would destroy
  // the Function URL and silently break every shipped game build pointing at it.
  if (status === "UPDATE_ROLLBACK_FAILED") {
    await cfn.send(new ContinueUpdateRollbackCommand({ StackName: stackName }));
    const settled = await waitUntilRollbackSettles(cfn);
    if (settled !== "UPDATE_ROLLBACK_COMPLETE") {
      throw new Error(`The previous change could not be rolled back (stack is ${settled}).`);
    }
  }

  try {
    await cfn.send(new UpdateStackCommand(args));
    return { operation: "UPDATE", stackName, templateKey, revision: templateRevision };
  } catch (e) {
    // Not an error: the account already runs exactly this template + code.
    if (/No updates are to be performed/i.test((e as Error).message ?? "")) {
      return { operation: "NO_CHANGE", stackName, templateKey, revision: templateRevision };
    }
    throw e;
  }
}

/** Poll until a continued rollback stops being in-progress; returns the final status. */
async function waitUntilRollbackSettles(cfn: CloudFormationClient): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const stack = await describe(cfn, stackName);
    const status = stack?.StackStatus ?? "";
    if (!IN_PROGRESS.test(status)) return status;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("Timed out waiting for the previous change to finish rolling back.");
}

export interface TeardownResult {
  /** What we actually asked AWS to remove (empty when there was nothing left). */
  removed: string[];
}

/**
 * The teardown hook (AGENTS.md §4). The host POSTs this at the START of teardown, then
 * deletes our stack itself — but certification runs with the host's cleanup OFF, so this
 * must do the real work on its own.
 *
 * MUST be idempotent: it can run more than once, including after a partial teardown, and
 * "already gone" is a success, not an error.
 *
 * Two things to remove: the stack (table, Lambda, role, log group, Function URL — all
 * in-stack, so DeleteStack handles them) and the deploy bucket, which lives OUTSIDE the
 * stack. We delete the bucket AFTER the stack is gone, so we never pull the Lambda code
 * out from under an in-flight stack operation.
 */
export async function teardown(ctx: AwsCtx): Promise<TeardownResult> {
  const { cfn, s3, region, accountId } = ctx;
  const removed: string[] = [];

  const stack = await describe(cfn, stackName);
  if (stack) {
    if (stack.StackStatus !== "DELETE_IN_PROGRESS") {
      await cfn.send(new DeleteStackCommand({ StackName: stackName }));
    }
    // Wait for the delete to actually land: returning early would report success while the
    // table still exists, and certification's tag sweep would (correctly) find it.
    await waitUntilStackDeleteComplete({ client: cfn, maxWaitTime: 600 }, { StackName: stackName });
    removed.push(stackName);
  }

  // The out-of-stack deploy bucket (idempotent — a missing bucket is success).
  const bucket = deployBucketName(accountId, region);
  if (await deleteDeployBucket(s3, bucket)) removed.push(bucket);

  return { removed };
}
