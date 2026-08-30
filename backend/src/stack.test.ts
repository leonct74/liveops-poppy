import { describe, expect, it, vi } from "vitest";
import {
  boundaryParameterValue,
  compareDeployment,
  deploy,
  templateKey,
  templateRevision,
  lambdaCodeKey,
  type AwsCtx,
} from "./stack";
import type { Stack } from "@aws-sdk/client-cloudformation";
import { templateJson } from "./generated/backend-bundle";

// The downgrade footgun this replaces: MailPoppy compared deployed vs embedded keys with
// plain inequality, so an OLDER installed app happily offered to roll a NEWER backend
// backwards (2026-07-29). These cases are the guard.
describe("compareDeployment (ordering-aware update check)", () => {
  it("offers an update when the deployed revision is older", () => {
    expect(compareDeployment({ revision: templateRevision - 1 })).toEqual({
      updateAvailable: true,
      appOutdated: false,
    });
  });

  it("NEVER offers a downgrade when the deployed revision is newer — flags the app instead", () => {
    expect(compareDeployment({ revision: templateRevision + 1, templateKey: "template-something-else" })).toEqual({
      updateAvailable: false,
      appOutdated: true,
    });
  });

  it("offers a same-revision rebuild when the template content differs", () => {
    expect(compareDeployment({ revision: templateRevision, templateKey: "template-older-bytes" })).toEqual({
      updateAvailable: true,
      appOutdated: false,
    });
  });

  it("offers a code-only change (template identical, Lambda zip moved)", () => {
    // The live lesson from TrafficPoppy: a CORS fix moved only the code key, and a
    // template-only comparison couldn't see the pending update.
    expect(compareDeployment({ revision: templateRevision, templateKey, codeKey: "collector-old.zip" })).toEqual({
      updateAvailable: true,
      appOutdated: false,
    });
  });

  it("says nothing when the deployment matches this build exactly", () => {
    expect(compareDeployment({ revision: templateRevision, templateKey, codeKey: lambdaCodeKey })).toEqual({
      updateAvailable: false,
      appOutdated: false,
    });
  });

  it("stays quiet for a stack that predates the tags (nothing to substantiate)", () => {
    expect(compareDeployment({})).toEqual({ updateAvailable: false, appOutdated: false });
  });
});

// broker-role-v2 step 2. The failure that matters is silent: a deploy that quietly drops an
// applied boundary leaves the roles uncapped and reports success.
const CONFIRMED = "arn:aws:iam::123456789012:policy/AgentsPoppyBoundary";

describe("boundaryParameterValue", () => {
  const deployed = (value?: string, StackStatus = "CREATE_COMPLETE"): Stack =>
    ({
      StackStatus,
      Parameters: value === undefined ? [] : [{ ParameterKey: "PermissionsBoundaryArn", ParameterValue: value }],
    }) as Stack;

  it("uses the ARN the host confirmed exists", () => {
    expect(boundaryParameterValue(CONFIRMED, null)).toBe(CONFIRMED);
  });

  it("PRESERVES the deployed boundary when the host didn't confirm one", () => {
    // Absence can be a transient host-side read, not a decision to remove the cap.
    expect(boundaryParameterValue(undefined, deployed(CONFIRMED))).toBe(CONFIRMED);
  });

  it("deploys unbounded on a fresh create, or when the stack carries no boundary", () => {
    // A CreateRole naming a policy that isn't in the account is refused by IAM, so this is
    // the only value that works before AgentsPoppy setup v3.
    expect(boundaryParameterValue(undefined, null)).toBe("");
    expect(boundaryParameterValue(undefined, deployed())).toBe("");
    expect(boundaryParameterValue(undefined, deployed(""))).toBe("");
  });

  it("carries NOTHING forward off a dead stack — the recreate must not inherit an unconfirmed ARN", () => {
    // ROLLBACK_COMPLETE/REVIEW_IN_PROGRESS get deleted and recreated: no live roles remain
    // to protect, and reusing the ARN recorded by a boundary-caused rollback would make the
    // next create fail the same way, forever.
    for (const dead of ["ROLLBACK_COMPLETE", "REVIEW_IN_PROGRESS"]) {
      expect(boundaryParameterValue(undefined, deployed(CONFIRMED, dead))).toBe("");
      // A CONFIRMED ARN has been checked to exist, so it still applies to the fresh create.
      expect(boundaryParameterValue(CONFIRMED, deployed("", dead))).toBe(CONFIRMED);
    }
  });
});

// The boundary must be visible to the UPDATE SIGNAL, or it can only ever land as a side
// effect of an unrelated change — and a stack already at the current revision with uncapped
// roles would never be reported as out of date again.
describe("compareDeployment (permissions boundary)", () => {
  const current = { revision: templateRevision, templateKey, codeKey: lambdaCodeKey };

  it("offers an update when the deployed roles are uncapped and the host now confirms a boundary", () => {
    expect(compareDeployment({ ...current, boundaryArn: "", confirmedBoundaryArn: CONFIRMED })).toEqual({
      updateAvailable: true,
      appOutdated: false,
    });
  });

  it("offers an update when the deployed boundary is a DIFFERENT ARN", () => {
    expect(
      compareDeployment({
        ...current,
        boundaryArn: "arn:aws:iam::123456789012:policy/OldBoundary",
        confirmedBoundaryArn: CONFIRMED,
      }),
    ).toEqual({ updateAvailable: true, appOutdated: false });
  });

  it("stays quiet once the deployed boundary already matches", () => {
    expect(
      compareDeployment({ ...current, boundaryArn: CONFIRMED, confirmedBoundaryArn: CONFIRMED }),
    ).toEqual({ updateAvailable: false, appOutdated: false });
  });

  it("stays quiet when the host confirms nothing — there is genuinely nothing to apply", () => {
    expect(compareDeployment({ ...current, boundaryArn: "" })).toEqual({
      updateAvailable: false,
      appOutdated: false,
    });
  });

  it("says nothing about a stack that doesn't exist (no boundaryArn passed)", () => {
    expect(compareDeployment({ confirmedBoundaryArn: CONFIRMED })).toEqual({
      updateAvailable: false,
      appOutdated: false,
    });
  });

  it("still refuses to offer a downgrade, boundary or not", () => {
    // Deploying from an older app would roll the backend backwards; the app updates first.
    expect(
      compareDeployment({ revision: templateRevision + 1, boundaryArn: "", confirmedBoundaryArn: CONFIRMED }),
    ).toEqual({ updateAvailable: false, appOutdated: true });
  });
});

// The template that SHIPS, not the one the source builds. infra/'s own tests assert the
// builder; this asserts the embedded artifact the backend actually hands CloudFormation, so
// a build-script change that drops the property can't pass unnoticed (the stale-bundle trap,
// CLAUDE.md gotcha #1, in test form).
describe("the embedded template", () => {
  const tpl = JSON.parse(templateJson) as {
    Parameters: Record<string, { Type: string; Default?: string }>;
    Conditions: Record<string, unknown>;
    Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>;
  };

  it("ships the boundary as an OPTIONAL parameter with a condition", () => {
    expect(tpl.Parameters.PermissionsBoundaryArn).toMatchObject({ Type: "String", Default: "" });
    expect(tpl.Conditions.HasPermissionsBoundary).toEqual({
      "Fn::Not": [{ "Fn::Equals": [{ Ref: "PermissionsBoundaryArn" }, ""] }],
    });
  });

  it("caps EVERY AWS::IAM::Role it ships", () => {
    const roles = Object.entries(tpl.Resources).filter(([, r]) => r.Type === "AWS::IAM::Role");
    expect(roles.length).toBeGreaterThan(0);
    for (const [name, r] of roles) {
      expect(r.Properties.PermissionsBoundary, `${name} must carry the boundary`).toEqual({
        "Fn::If": ["HasPermissionsBoundary", { Ref: "PermissionsBoundaryArn" }, { Ref: "AWS::NoValue" }],
      });
    }
  });
});

// The deploy path end to end (AWS injected): which value actually reaches CloudFormation.
describe("deploy — the PermissionsBoundaryArn it sends", () => {
  const attribution = { accountId: "123456789012", connectionId: "conn-1" };
  const cmd = (c: unknown) => (c as { constructor: { name: string } }).constructor.name;
  const notFound = () =>
    Object.assign(new Error("Stack with id LiveOpsPoppyStack does not exist"), { name: "ValidationError" });
  const live = (status: string, boundary?: string): Stack =>
    ({
      StackStatus: status,
      Parameters: boundary === undefined ? [] : [{ ParameterKey: "PermissionsBoundaryArn", ParameterValue: boundary }],
    }) as Stack;

  /** A fake AWS: `describes` are answered in order (the last repeats); an Error is thrown. */
  function fakeAws(describes: unknown[], permissionsBoundaryArn?: string) {
    const sent: { name: string; input: any }[] = [];
    let i = 0;
    const cfn = {
      send: vi.fn(async (c: any) => {
        sent.push({ name: cmd(c), input: c.input });
        if (cmd(c) === "DescribeStacksCommand") {
          const next = describes[Math.min(i++, describes.length - 1)];
          if (next instanceof Error) throw next;
          return { Stacks: next ? [next] : [] };
        }
        return {};
      }),
    };
    const s3 = { send: vi.fn(async () => ({})) };
    const ctx = {
      cfn,
      s3,
      region: "eu-west-1",
      accountId: "123456789012",
      ...(permissionsBoundaryArn ? { permissionsBoundaryArn } : {}),
    } as unknown as AwsCtx;
    return { ctx, sent, s3 };
  }

  const boundaryOf = (sent: { name: string; input: any }[], name: string) =>
    sent
      .find((c) => c.name === name)!
      .input.Parameters.find((p: any) => p.ParameterKey === "PermissionsBoundaryArn").ParameterValue;

  it("ABORTS when the stack can't be read — an unreadable stack is not an absent one", async () => {
    // Answering "" to a read we couldn't make would strip the cap off every existing role.
    const { ctx, sent, s3 } = fakeAws([Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" })]);
    await expect(deploy(ctx, attribution)).rejects.toThrow(/Couldn't read your LiveOpsPoppy stack/);
    expect(sent.some((c) => c.name === "CreateStackCommand" || c.name === "UpdateStackCommand")).toBe(false);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it("creates unbounded when nothing is deployed and the host confirms nothing", async () => {
    const { ctx, sent } = fakeAws([notFound()]);
    expect((await deploy(ctx, attribution)).operation).toBe("CREATE");
    expect(boundaryOf(sent, "CreateStackCommand")).toBe("");
  });

  it("creates with the confirmed boundary when the host supplies one", async () => {
    const { ctx, sent } = fakeAws([notFound()], CONFIRMED);
    await deploy(ctx, attribution);
    expect(boundaryOf(sent, "CreateStackCommand")).toBe(CONFIRMED);
  });

  it("PRESERVES the deployed boundary on a routine update the host didn't confirm", async () => {
    const { ctx, sent } = fakeAws([live("CREATE_COMPLETE", CONFIRMED)]);
    expect((await deploy(ctx, attribution)).operation).toBe("UPDATE");
    expect(boundaryOf(sent, "UpdateStackCommand")).toBe(CONFIRMED);
  });

  it("does NOT carry a dead stack's unconfirmed boundary into the recreate", async () => {
    // The self-perpetuating outage: if that ARN is what rolled the create back, reusing it
    // rolls the retry back too. First describe = the dead stack; then it's gone (the waiter).
    const { ctx, sent } = fakeAws([live("ROLLBACK_COMPLETE", CONFIRMED), notFound()]);
    expect((await deploy(ctx, attribution)).operation).toBe("RECREATE");
    expect(sent.some((c) => c.name === "DeleteStackCommand")).toBe(true);
    expect(boundaryOf(sent, "CreateStackCommand")).toBe("");
  });
});
