import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Team, TEAM_PRODUCT_ID, displayPrice } from "./Team";
import type { Api, TeamStatus } from "./api";

/** A yearly $12 plan — the shipped price (DESIGN §10). */
const YEARLY = { amountMinor: 1200, currency: "usd", kind: "subscription" as const, interval: "year" };

function bridgeOf(over: Partial<Record<string, unknown>> = {}) {
  return {
    isPurchased: vi.fn().mockResolvedValue(false),
    purchaseInfo: vi.fn().mockResolvedValue({ price: YEARLY, owned: false }),
    buyProduct: vi.fn().mockResolvedValue({ owned: true }),
    manageSubscription: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as never;
}

function apiOf(status: TeamStatus = { enabled: false }, over: Partial<Api> = {}) {
  return {
    teamStatus: vi.fn().mockResolvedValue(status),
    enableTeam: vi.fn().mockResolvedValue({ operation: "op" }),
    disableTeam: vi.fn().mockResolvedValue({ operation: "op" }),
    inviteViewer: vi.fn().mockResolvedValue({ email: "p@s.example", status: "invited" }),
    removeViewer: vi.fn().mockResolvedValue({ ok: true }),
    ...over,
  } as unknown as Api;
}

const ENABLED: TeamStatus = {
  enabled: true,
  dashboardUrl: "https://viewer.lambda-url.eu-west-1.on.aws/",
  userPoolId: "eu-west-1_POOL",
  viewers: [],
};

describe("displayPrice", () => {
  it("headlines a yearly plan MONTHLY but always states the real yearly charge", () => {
    // The founder's framing: "$1/month", billed yearly. Showing the monthly figure without
    // the yearly total next to it would be a dark pattern.
    const p = displayPrice(YEARLY)!;
    expect(p.headline).toMatch(/1\.00\/month/);
    expect(p.note).toMatch(/billed yearly/);
    expect(p.note).toMatch(/12\.00/);
  });

  it("does not invent a monthly figure for a one-off purchase", () => {
    const p = displayPrice({ amountMinor: 4900, currency: "usd", kind: "one_time" })!;
    expect(p.headline).toMatch(/49\.00/);
    expect(p.note).toBeUndefined();
  });

  it("follows the LIVE price rather than a hardcoded string", () => {
    expect(displayPrice({ ...YEARLY, amountMinor: 2400 })!.headline).toMatch(/2\.00\/month/);
    expect(displayPrice(null)).toBeNull();
  });
});

describe("before the backend exists", () => {
  it("asks for setup instead of offering a purchase — and asks the host nothing", () => {
    const bridge = bridgeOf() as never as { isPurchased: ReturnType<typeof vi.fn> };
    render(<Team api={apiOf()} titleId="t1" isLive={false} bridge={bridge as never} />);
    expect(screen.getByText(/Set up your backend first/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /unlock/i })).not.toBeInTheDocument();
    // With no deployment there is nothing to unlock, so the host is never asked.
    expect(bridge.isPurchased).not.toHaveBeenCalled();
  });
});

describe("the paywall", () => {
  it("shows a real buy control, not an empty custom element", async () => {
    // Regression guard: this repo inlines the host bridge, so <agentspoppy-purchase>
    // does not exist — rendering one would leave a silently dead paywall.
    render(<Team api={apiOf()} titleId="t1" isLive bridge={bridgeOf()} />);
    const buy = await screen.findByRole("button", { name: /unlock/i });
    expect(buy).toBeInTheDocument();
    expect(document.querySelector("agentspoppy-purchase")).toBeNull();
  });

  it("prices per title and drives the host checkout for THAT title", async () => {
    const user = userEvent.setup();
    const bridge = bridgeOf();
    render(<Team api={apiOf()} titleId="game-42" isLive bridge={bridge} />);

    await user.click(await screen.findByRole("button", { name: /unlock/i }));
    await waitFor(() =>
      expect((bridge as never as { buyProduct: ReturnType<typeof vi.fn> }).buyProduct).toHaveBeenCalledWith(
        TEAM_PRODUCT_ID,
        { target: "game-42" },
      ),
    );
  });

  it("re-asks the host after checkout instead of trusting the return value", async () => {
    const user = userEvent.setup();
    const isPurchased = vi.fn().mockResolvedValue(false);
    const bridge = bridgeOf({ isPurchased });
    render(<Team api={apiOf()} titleId="t1" isLive bridge={bridge} />);

    await waitFor(() => expect(isPurchased).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: /unlock/i }));
    // Ownership is verified server-side; the buyProduct resolve value is not authority.
    await waitFor(() => expect(isPurchased).toHaveBeenCalledTimes(2));
  });

  it("fails CLOSED when the host can't be reached — no free unlock", async () => {
    const bridge = bridgeOf({ isPurchased: vi.fn().mockRejectedValue(new Error("bridge down")) });
    render(<Team api={apiOf()} titleId="t1" isLive bridge={bridge} />);
    expect(await screen.findByRole("button", { name: /unlock/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /set up the team dashboard/i })).not.toBeInTheDocument();
  });

  it("does not offer setup until the title is actually paid for", async () => {
    render(<Team api={apiOf()} titleId="t1" isLive bridge={bridgeOf()} />);
    await screen.findByRole("button", { name: /unlock/i });
    expect(screen.queryByRole("button", { name: /set up the team dashboard/i })).not.toBeInTheDocument();
  });
});

describe("once the title is owned", () => {
  const owned = () => bridgeOf({ isPurchased: vi.fn().mockResolvedValue(true) });

  it("ALWAYS shows Manage billing — the platform rule", async () => {
    // Removing this control is grounds for removal from the directory.
    render(<Team api={apiOf()} titleId="t1" isLive bridge={owned()} />);
    expect(await screen.findByRole("button", { name: /manage billing/i })).toBeInTheDocument();
  });

  it("Manage billing opens the portal for this title", async () => {
    const user = userEvent.setup();
    const bridge = owned();
    render(<Team api={apiOf()} titleId="game-7" isLive bridge={bridge} />);
    await user.click(await screen.findByRole("button", { name: /manage billing/i }));
    expect(
      (bridge as never as { manageSubscription: ReturnType<typeof vi.fn> }).manageSubscription,
    ).toHaveBeenCalledWith(TEAM_PRODUCT_ID, { target: "game-7" });
  });

  it("offers setup when the dashboard isn't deployed yet", async () => {
    const api = apiOf();
    const user = userEvent.setup();
    render(<Team api={api} titleId="t1" isLive bridge={owned()} />);
    await user.click(await screen.findByRole("button", { name: /set up the team dashboard/i }));
    await waitFor(() => expect(api.enableTeam).toHaveBeenCalled());
  });

  /**
   * 🪤 enableTeam() returns when AWS ACCEPTS the update, ~2 minutes before ViewerUrl
   * exists. The panel used to read the status once at that moment, see no viewer plane,
   * and never look again — the founder got "no team to set up" from a stack that was busy
   * building precisely that, plus a stale CloudFormation error, until a tab remount
   * (2026-08-14). It must keep reading until the plane actually appears.
   */
  it("keeps checking after setup until the viewer plane actually appears", async () => {
    let reads = 0;
    const api = apiOf(
      { enabled: false },
      {
        // Mid-update reads are allowed to THROW: a transient failure must not abandon a
        // change AWS already accepted.
        teamStatus: vi.fn(async () => {
          reads += 1;
          if (reads === 2) throw new Error("Stack is in UPDATE_IN_PROGRESS state");
          return reads >= 4 ? ENABLED : { enabled: false };
        }),
      },
    );
    const user = userEvent.setup();
    render(<Team api={api} titleId="t1" isLive bridge={owned()} pollMs={5} />);
    await user.click(await screen.findByRole("button", { name: /set up the team dashboard/i }));

    // The address only renders once the plane is real — this is the whole point.
    expect(await screen.findByText(ENABLED.dashboardUrl!)).toBeInTheDocument();
    expect(screen.queryByText(/UPDATE_IN_PROGRESS/)).not.toBeInTheDocument();
  });
});

describe("when the dashboard is live", () => {
  const owned = () => bridgeOf({ isPurchased: vi.fn().mockResolvedValue(true) });

  it("shows the fixed address the team bookmarks", async () => {
    render(<Team api={apiOf(ENABLED)} titleId="t1" isLive bridge={owned()} />);
    expect(await screen.findByText(ENABLED.dashboardUrl!)).toBeInTheDocument();
  });

  it("says plainly when nobody is invited yet", async () => {
    render(<Team api={apiOf(ENABLED)} titleId="t1" isLive bridge={owned()} />);
    expect(await screen.findByText(/Nobody yet/i)).toBeInTheDocument();
  });

  it("distinguishes a pending invite from an active account", async () => {
    const status = {
      ...ENABLED,
      viewers: [
        { email: "new@s.example", status: "invited" as const },
        { email: "old@s.example", status: "active" as const },
      ],
    };
    render(<Team api={apiOf(status)} titleId="t1" isLive bridge={owned()} />);
    expect(await screen.findByText(/hasn't signed in yet/i)).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("invites a viewer and clears the field", async () => {
    const user = userEvent.setup();
    const api = apiOf(ENABLED);
    render(<Team api={api} titleId="t1" isLive bridge={owned()} />);

    const field = await screen.findByPlaceholderText(/producer@yourstudio.com/i);
    await user.type(field, "producer@studio.example");
    await user.click(screen.getByRole("button", { name: /^invite$/i }));

    await waitFor(() => expect(api.inviteViewer).toHaveBeenCalledWith("producer@studio.example"));
    await waitFor(() => expect(field).toHaveValue(""));
  });

  it("surfaces a rejected invite instead of failing silently", async () => {
    const user = userEvent.setup();
    const api = apiOf(ENABLED, {
      inviteViewer: vi.fn().mockRejectedValue(new Error("producer@studio.example has already been invited.")),
    });
    render(<Team api={api} titleId="t1" isLive bridge={owned()} />);

    await user.type(await screen.findByPlaceholderText(/producer@yourstudio.com/i), "producer@studio.example");
    await user.click(screen.getByRole("button", { name: /^invite$/i }));
    expect(await screen.findByText(/already been invited/i)).toBeInTheDocument();
  });

  it("removes a viewer", async () => {
    const user = userEvent.setup();
    const api = apiOf({ ...ENABLED, viewers: [{ email: "old@s.example", status: "active" }] });
    render(<Team api={api} titleId="t1" isLive bridge={owned()} />);

    await user.click(await screen.findByRole("button", { name: /^remove$/i }));
    await waitFor(() => expect(api.removeViewer).toHaveBeenCalledWith("old@s.example"));
  });
});

describe("removing the dashboard", () => {
  const owned = () => bridgeOf({ isPurchased: vi.fn().mockResolvedValue(true) });

  it("warns that sign-ins are destroyed and the address changes, and confirms first", async () => {
    const user = userEvent.setup();
    const api = apiOf(ENABLED);
    render(<Team api={api} titleId="t1" isLive bridge={owned()} />);

    await user.click(await screen.findByRole("button", { name: /^remove the team dashboard$/i }));
    expect(screen.getByText(/loses access/i)).toBeInTheDocument();
    expect(api.disableTeam).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /yes, remove it/i }));
    await waitFor(() => expect(api.disableTeam).toHaveBeenCalled());
  });

  it("lets the owner back out", async () => {
    const user = userEvent.setup();
    const api = apiOf(ENABLED);
    render(<Team api={api} titleId="t1" isLive bridge={owned()} />);

    await user.click(await screen.findByRole("button", { name: /^remove the team dashboard$/i }));
    await user.click(screen.getByRole("button", { name: /keep it/i }));
    expect(api.disableTeam).not.toHaveBeenCalled();
  });
});
