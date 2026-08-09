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
 */
export function compareDeployment(deployed: {
  revision?: number;
  templateKey?: string;
  codeKey?: string;
}): { updateAvailable: boolean; appOutdated: boolean } {
  const { revision, templateKey: dTemplate, codeKey: dCode } = deployed;
  if (revision !== undefined && revision > templateRevision) {
    return { updateAvailable: false, appOutdated: true };
  }
  if (revision !== undefined && revision < templateRevision) {
    return { updateAvailable: true, appOutdated: false };
  }
  // Same revision (or none recorded): the content keys are the only signal left. A stack
  // with no keys at all predates both tags — say nothing rather than nag about an update
  // we cannot substantiate.
  const contentDiffers =
    (!!dTemplate && dTemplate !== templateKey) || (!!dCode && dCode !== lambdaCodeKey);
  return { updateAvailable: contentDiffers, appOutdated: false };
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
export async function deploy(ctx: AwsCtx, attribution: AttributionContext): Promise<DeployResult> {
  const { cfn, s3, region, accountId } = ctx;
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
  const before = await describe(cfn, stackName);
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

  const args = {
    StackName: stackName,
    TemplateBody: templateJson,
    Parameters: [
      { ParameterKey: "LambdaCodeBucket", ParameterValue: bucket },
      { ParameterKey: "LambdaCodeKey", ParameterValue: lambdaCodeKey },
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
