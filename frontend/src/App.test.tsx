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
});
