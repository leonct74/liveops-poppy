import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { demoApi } from "./demo";
import type { Api } from "./api";
import type { DeploymentStatus } from "./types";

/** A live-looking Api: deployed stack, one real title. */
function liveApi(over: Partial<Api> = {}): Api {
  const status: DeploymentStatus = {
    phase: "ready",
    stackName: "LiveOpsPoppyStack",
    region: "eu-west-1",
    inProgress: false,
    currentTemplateKey: "template-x",
    currentRevision: 1,
    deployedRevision: 1,
    updateAvailable: false,
    appOutdated: false,
    collectorUrl: "https://abc123.lambda-url.eu-west-1.on.aws/",
  };
  const demo = demoApi();
  return {
    ...demo,
    status: vi.fn(async () => status),
    listTitles: vi.fn(async () => ({
      titles: [
        { titleId: "real0001", name: "My Real Game", createdAt: "2026-08-01T00:00:00Z", eventCap: 500_000, cardCap: 200 },
      ],
    })),
    ...over,
  };
}

describe("App", () => {
  it("starts on demo data and says so plainly", async () => {
    render(<App apiImpl={demoApi()} />);
    expect(await screen.findByText(/You're looking at demo data/)).toBeInTheDocument();
    // The demo must look like a real game, not an empty state.
    expect(await screen.findByText(/Players today/)).toBeInTheDocument();
  });

  it("drops the demo banner once the stack is really deployed", async () => {
    render(<App apiImpl={liveApi()} />);
    await waitFor(() => expect(screen.queryByText(/You're looking at demo data/)).not.toBeInTheDocument());
  });

  it("puts Feedback last, as every poppy must", () => {
    render(<App apiImpl={demoApi()} />);
    const tabs = screen.getAllByRole("button").filter((b) => b.className.includes("tab"));
    expect(tabs[tabs.length - 1]).toHaveTextContent("Feedback");
  });

  it("shows the real title's name after deployment", async () => {
    render(<App apiImpl={liveApi()} />);
    await userEvent.click(screen.getByRole("button", { name: "Titles & SDK" }));
    expect(await screen.findByText("My Real Game")).toBeInTheDocument();
  });

  it("hides mutating controls while on demo data", async () => {
    render(<App apiImpl={demoApi()} />);
    await userEvent.click(screen.getByRole("button", { name: "Titles & SDK" }));
    await screen.findByText(/Sunken Keep/);
    expect(screen.queryByRole("button", { name: "Create" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rotate key" })).not.toBeInTheDocument();
  });

  /**
   * Live backend + no titles = the onboarding gap the founder hit (2026-08-11): the tab
   * order serves the hundredth visit, so the FIRST visit needs the app to point the way.
   * A banner names the next step in plain words and jumps straight to Titles & SDK.
   */
  it("guides a live-but-empty deployment to 'Create your game', and jumps there", async () => {
    const api = liveApi({ listTitles: vi.fn(async () => ({ titles: [] })) });
    render(<App apiImpl={api} />);

    expect(await screen.findByText(/Your backend is live/)).toBeInTheDocument();
    expect(screen.getByText(/register your game/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create your game" }));
    expect(screen.getByRole("button", { name: "Titles & SDK" })).toHaveAttribute("aria-current", "page");
    // No demo banner in live mode, and no next-step banner once a title exists (below).
    expect(screen.queryByText(/You're looking at demo data/)).not.toBeInTheDocument();
  });

  it("drops the next-step banner once a title exists", async () => {
    render(<App apiImpl={liveApi()} />);
    await waitFor(() => expect(screen.queryByText(/Your backend is live\./)).not.toBeInTheDocument());
  });

  /**
   * The app must flip demo → live BY ITSELF when the stack completes. The Setup panel
   * only polls while mounted, so a user who starts a deploy and browses other tabs
   * (what a two-minute wait invites) previously stayed on "demo data" forever — the
   * founder's first real run hit exactly this (2026-08-11).
   */
  it("flips from demo to live on its own once the stack becomes ready", async () => {
    let calls = 0;
    const api = liveApi({
      status: vi.fn(async () => {
        calls++;
        const ready = calls > 1;
        return {
          phase: ready ? ("ready" as const) : ("deploying" as const),
          stackName: "LiveOpsPoppyStack",
          region: "eu-west-1",
          inProgress: !ready,
          currentTemplateKey: "template-x",
          currentRevision: 1,
          deployedRevision: ready ? 1 : undefined,
          updateAvailable: false,
          appOutdated: false,
          ...(ready ? { collectorUrl: "https://abc123.lambda-url.eu-west-1.on.aws/" } : {}),
        };
      }),
    });
    render(<App apiImpl={api} statusPollMs={25} />);

    // First probe: still building — the app honestly shows demo data.
    expect(await screen.findByText(/You're looking at demo data/)).toBeInTheDocument();

    // A later self-initiated probe hears "ready" — no tab visit, no restart.
    await waitFor(() => expect(screen.queryByText(/You're looking at demo data/)).not.toBeInTheDocument(), {
      timeout: 3000,
    });
  });

  it("lands on the tab named by ?screen= (how listing screenshots are captured), else dashboard", async () => {
    window.history.replaceState(null, "", "/?screen=config");
    try {
      render(<App apiImpl={demoApi()} />);
      expect(screen.getByRole("button", { name: "Remote config" })).toHaveAttribute("aria-current", "page");
    } finally {
      window.history.replaceState(null, "", "/");
    }

    window.history.replaceState(null, "", "/?screen=nonsense");
    try {
      render(<App apiImpl={demoApi()} />);
      expect(screen.getAllByRole("button", { name: "Dashboard" }).pop()).toHaveAttribute("aria-current", "page");
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });
});
