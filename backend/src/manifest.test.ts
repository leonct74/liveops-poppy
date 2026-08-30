// The manifest is a security document, not just metadata: it is the exact list of powers the
// user consents to, and it is what the broker compiles into the session policy. These tests
// lock the properties that a well-meaning edit could quietly undo.
//
// The one that matters most: a Cognito user pool's ARN carries an AWS-generated id, so a
// grant over it can only ever be `tagged-as-self` or a wildcard. A wildcard would reach EVERY
// user pool in the account — including another poppy's (a mail poppy's mailboxes, say). The
// split below is TrafficPoppy's, and it is the only shape that keeps the consent text true.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ID } from "./tags";

interface Grant {
  service: string;
  actions: string[];
  resourceScope: string;
}

const manifest = JSON.parse(readFileSync(join(__dirname, "../../extension.json"), "utf8")) as {
  id: string;
  permissionSet: { description: string; grants: Grant[] };
};

const grants = manifest.permissionSet.grants;
const cognito = grants.filter((g) => g.service === "cognito-idp");

/** Anything that can read a user, change a pool, or destroy one. */
const REACHES_EXISTING = /^(Delete|Update|Admin|List|Set)/;

describe("extension.json permission set", () => {
  it("declares the app id the attribution tags are keyed on", () => {
    expect(manifest.id).toBe(APP_ID);
  });

  it("never lets a destructive or user-reading Cognito action escape the tag scope", () => {
    for (const grant of cognito) {
      const reaching = grant.actions.filter((a) => REACHES_EXISTING.test(a));
      if (reaching.length === 0) continue;
      expect(
        grant.resourceScope,
        `these act on pools that already exist and MUST be tag-scoped: ${reaching.join(", ")}`,
      ).toBe("tagged-as-self");
    }
  });

  it("keeps the un-scopable Cognito grant to creates and describes only", () => {
    const broad = cognito.filter((g) => g.resourceScope !== "tagged-as-self");
    expect(broad).toHaveLength(1);
    // Tag/UntagResource earn their place: CloudFormation tags a pool in a SEPARATE call after
    // creating it, so without them the deploy rolls back on AccessDenied (CrewPoppy, live,
    // 2026-07-30). They can add or remove OUR tag on a pool; they cannot read or delete one.
    for (const action of broad[0]!.actions) {
      expect(action, `${action} reaches an existing pool — move it to tagged-as-self`).toMatch(
        /^(Create|Describe|TagResource|UntagResource)/,
      );
    }
  });

  it("does not claim in plain language that nothing outside LiveOpsPoppy* is reachable", () => {
    // The description is the consent text. While a Cognito pool is reachable by tag rather
    // than by name, a flat "it cannot touch anything else" would be false — and a false
    // disclosure is a listing violation, not a wording preference.
    const d = manifest.permissionSet.description;
    expect(d).toMatch(/user pool/i);
    expect(d).toMatch(/tag/i);
  });

  it("can attach AND detach the AgentsPoppy boundary, on its own roles only", () => {
    // broker-role-v2 step 2. BOTH actions are needed: CloudFormation attaches the boundary
    // when the parameter is set, and calls DeleteRolePermissionsBoundary when an update
    // clears it — without the delete, the stack strands mid-update. They CAP the poppy's own
    // roles and grant them nothing, so they belong on the existing name-scoped grant and
    // must never widen past it.
    const iam = grants.filter((g) => g.service === "iam");
    expect(iam).toHaveLength(1);
    expect(iam[0]!.resourceScope).toBe("arn:aws:iam::*:role/LiveOpsPoppy*");
    expect(iam[0]!.actions).toContain("PutRolePermissionsBoundary");
    expect(iam[0]!.actions).toContain("DeleteRolePermissionsBoundary");
  });

  it("grants no service a bare wildcard scope except AWS's public price list", () => {
    for (const grant of grants) {
      if (grant.resourceScope !== "*") continue;
      expect(grant.service, "a '*' scope is unattributable — teardown cannot find it").toBe("pricing");
      expect(grant.actions).toEqual(["GetProducts"]);
    }
  });
});
