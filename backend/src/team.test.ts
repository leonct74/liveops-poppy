import { describe, expect, it, vi } from "vitest";
import {
  emailProblem,
  getTeamStatus,
  inviteViewer,
  listViewers,
  removeViewer,
  temporaryPassword,
  viewerStatus,
  type TeamDeps,
} from "./team";

const name = (c: unknown) => (c as { constructor: { name: string } }).constructor.name;
const input = (c: unknown) => (c as { input: any }).input;

function deps(over: Partial<TeamDeps> & { users?: any[] } = {}): TeamDeps & { sent: unknown[] } {
  const sent: unknown[] = [];
  const users = over.users ?? [];
  return {
    sent,
    cognito: {
      send: vi.fn(async (c: unknown) => {
        sent.push(c);
        if (name(c) === "ListUsersCommand") return { Users: users };
        return {};
      }),
    },
    outputs: over.outputs ?? (async () => ({
      CollectorUrl: "https://collector.example/",
      ViewerUrl: "https://viewer.lambda-url.eu-west-1.on.aws/",
      ViewerPoolId: "eu-west-1_POOL",
      ViewerClientId: "client-1",
    })),
    random: () => "abcdefghijklmnop",
  };
}

describe("emailProblem", () => {
  it("accepts a real address and rejects the rest", () => {
    expect(emailProblem("producer@studio.example")).toBeNull();
    for (const bad of ["", "   ", "nope", "a@b", "a b@c.com", undefined, 42, "x".repeat(250) + "@a.com"]) {
      expect(emailProblem(bad as never)).toMatch(/required|doesn't look/);
    }
  });
});

describe("viewerStatus", () => {
  it("translates Cognito's vocabulary into words an admin understands", () => {
    expect(viewerStatus("FORCE_CHANGE_PASSWORD", true)).toBe("invited");
    expect(viewerStatus("RESET_REQUIRED", true)).toBe("invited");
    expect(viewerStatus("CONFIRMED", true)).toBe("active");
    expect(viewerStatus("CONFIRMED", false)).toBe("disabled");
    expect(viewerStatus("SOMETHING_NEW", true)).toBe("unknown");
  });
});

describe("temporaryPassword", () => {
  it("satisfies the pool's policy BY CONSTRUCTION, not by luck", () => {
    // Pool policy: ≥10 chars, a lowercase letter and a digit.
    for (const r of ["aaaaaaaaaaaaaaaa", "0000000000000000", "zZ9".repeat(6)]) {
      const pw = temporaryPassword(() => r);
      expect(pw.length).toBeGreaterThanOrEqual(10);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[0-9]/);
    }
  });
});

describe("getTeamStatus", () => {
  it("reports enabled + the dashboard address when the stack carries the viewer plane", async () => {
    const d = deps({ users: [{ Username: "p@s.example", UserStatus: "CONFIRMED", Enabled: true, Attributes: [{ Name: "email", Value: "p@s.example" }] }] });
    const status = await getTeamStatus(d);
    expect(status).toMatchObject({
      enabled: true,
      dashboardUrl: "https://viewer.lambda-url.eu-west-1.on.aws/",
      userPoolId: "eu-west-1_POOL",
    });
    expect(status.viewers).toEqual([{ email: "p@s.example", status: "active", createdAt: undefined }]);
  });

  /** The outputs are condition-gated in the template, so absence IS the answer. */
  it("reports disabled when the viewer outputs are absent — and asks Cognito nothing", async () => {
    const d = deps({ outputs: async () => ({ CollectorUrl: "https://collector.example/" }) });
    expect(await getTeamStatus(d)).toEqual({ enabled: false });
    expect(d.sent).toHaveLength(0);
  });
});

describe("listViewers", () => {
  it("prefers the email attribute, sorts, and drops rows with no address", async () => {
    const d = deps({
      users: [
        { Username: "z", UserStatus: "CONFIRMED", Enabled: true, Attributes: [{ Name: "email", Value: "zoe@s.example" }] },
        { Username: "a", UserStatus: "FORCE_CHANGE_PASSWORD", Enabled: true, Attributes: [{ Name: "email", Value: "amy@s.example" }] },
        { Username: "", UserStatus: "CONFIRMED", Enabled: true, Attributes: [] },
      ],
    });
    const list = await listViewers(d, "eu-west-1_POOL");
    expect(list.map((v) => v.email)).toEqual(["amy@s.example", "zoe@s.example"]);
    expect(list[0]!.status).toBe("invited");
  });
});

describe("inviteViewer", () => {
  it("creates a pre-verified user with a temporary password and emails the invite", async () => {
    const d = deps();
    const result = await inviteViewer(d, "eu-west-1_POOL", "  Producer@Studio.Example  ");
    expect(result).toEqual({ email: "producer@studio.example", status: "invited" });

    const cmd = d.sent.find((c) => name(c) === "AdminCreateUserCommand")!;
    expect(input(cmd).UserPoolId).toBe("eu-west-1_POOL");
    // Normalised: Cognito usernames are case-sensitive, so an un-lowercased invite would
    // create a second account for the same person.
    expect(input(cmd).Username).toBe("producer@studio.example");
    expect(input(cmd).UserAttributes).toContainEqual({ Name: "email_verified", Value: "true" });
    expect(input(cmd).DesiredDeliveryMediums).toEqual(["EMAIL"]);
    expect(String(input(cmd).TemporaryPassword).length).toBeGreaterThanOrEqual(10);
  });

  it("refuses a malformed address before touching Cognito", async () => {
    const d = deps();
    await expect(inviteViewer(d, "pool", "not-an-email")).rejects.toThrow(/doesn't look like an email/);
    expect(d.sent).toHaveLength(0);
  });

  it("explains a duplicate invite in plain words", async () => {
    const d = deps();
    d.cognito.send = vi.fn(async () => {
      const e = new Error("exists");
      e.name = "UsernameExistsException";
      throw e;
    });
    await expect(inviteViewer(d, "pool", "p@s.example")).rejects.toThrow(/already been invited/);
  });
});

describe("removeViewer", () => {
  it("deletes the account — tokens expire within the hour and cannot be renewed", async () => {
    const d = deps();
    await removeViewer(d, "eu-west-1_POOL", "Producer@Studio.Example");
    const cmd = d.sent.find((c) => name(c) === "AdminDeleteUserCommand")!;
    expect(input(cmd)).toMatchObject({ UserPoolId: "eu-west-1_POOL", Username: "producer@studio.example" });
  });

  it("treats an already-removed viewer as success (revoking twice must not error)", async () => {
    const d = deps();
    d.cognito.send = vi.fn(async () => {
      const e = new Error("gone");
      e.name = "UserNotFoundException";
      throw e;
    });
    await expect(removeViewer(d, "pool", "p@s.example")).resolves.toBeUndefined();
  });

  it("refuses a malformed address before touching Cognito", async () => {
    const d = deps();
    await expect(removeViewer(d, "pool", "nope")).rejects.toThrow(/doesn't look like an email/);
    expect(d.sent).toHaveLength(0);
  });
});
