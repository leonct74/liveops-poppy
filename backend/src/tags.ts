// Attribution tags — the three keys AgentsPoppy uses for scoping + teardown.
//
// Every resource LiveOpsPoppy creates MUST carry all three, or it becomes (a) invisible
// to the host's tag sweep (= a leak that fails the leaves-no-trace check) and (b)
// unreachable by our own scoped credentials. See AGENTS.md §3 "Attribution", §4.
//
// We stamp them ONCE, on the stack: CloudFormation propagates stack-level tags to most
// taggable resources it creates, so the table is tagged without us tagging it by hand.
//
// "Most", not "every" — TrafficPoppy's P5 caught CFN's ACM handler dropping tags on create.
// So any resource whose GRANT depends on the tag (rather than on its name) must ALSO be
// tagged explicitly in the template: see the viewer user pool, whose AWS-generated id makes
// tag-scoping the only option available. Propagation is a convenience; explicit tags are the
// security boundary.

export const APP_ID = "com.liveopspoppy.desktop";

export const TAG_ACCOUNT = "agentspoppy:account";
export const TAG_APP = "agentspoppy:app";
export const TAG_CONNECTION = "agentspoppy:connection";

/** Marks the stack as ours in the AWS console, next to the AgentsPoppy attribution. */
export const TAG_MANAGED = "agentspoppy:managed";

/** The open-repo commit this build's template came from — auditable provenance. */
export const TAG_SOURCE_COMMIT = "liveopspoppy:sourceCommit";

export interface AttributionContext {
  accountId: string;
  connectionId: string;
  /** The commit this build came from; omitted when built outside a git checkout. */
  sourceCommit?: string;
}

/** The tags every stack we create carries, as a CloudFormation Tag[]. */
export function stackTags(ctx: AttributionContext): { Key: string; Value: string }[] {
  const tags = [
    { Key: TAG_ACCOUNT, Value: ctx.accountId },
    { Key: TAG_APP, Value: APP_ID },
    { Key: TAG_CONNECTION, Value: ctx.connectionId },
    { Key: TAG_MANAGED, Value: "liveopspoppy" },
  ];
  if (ctx.sourceCommit) tags.push({ Key: TAG_SOURCE_COMMIT, Value: ctx.sourceCommit });
  return tags;
}
