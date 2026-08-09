import { describe, expect, it } from "vitest";
import { compareDeployment, templateKey, templateRevision, lambdaCodeKey } from "./stack";

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
