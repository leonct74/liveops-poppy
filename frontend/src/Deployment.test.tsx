import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Deployment } from "./Deployment";
import { demoApi } from "./demo";
import type { Api } from "./api";
import type { DeploymentStatus } from "./types";

const base: DeploymentStatus = {
  phase: "none",
  stackName: "LiveOpsPoppyStack",
  region: "eu-west-1",
  inProgress: false,
  currentTemplateKey: "template-x",
  currentRevision: 2,
  updateAvailable: false,
  appOutdated: false,
};

function apiWith(status: Partial<DeploymentStatus>, over: Partial<Api> = {}): Api {
  return {
    ...demoApi(),
    status: vi.fn(async () => ({ ...base, ...status })),
    deploy: vi.fn(async () => ({ operation: "CREATE", stackName: "LiveOpsPoppyStack" })),
    teardown: vi.fn(async () => ({ ok: true as const, removed: ["LiveOpsPoppyStack"] })),
    ...over,
  };
}

describe("Deployment", () => {
  it("offers setup when nothing is deployed", async () => {
    const api = apiWith({ phase: "none" });
    render(<Deployment api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Set up my backend" }));
    await waitFor(() => expect(api.deploy).toHaveBeenCalled());
  });

  it("shows the endpoint the games talk to once ready", async () => {
    render(<Deployment api={apiWith({ phase: "ready", collectorUrl: "https://x.lambda-url.aws/" })} />);
    expect(await screen.findByText("https://x.lambda-url.aws/")).toBeInTheDocument();
  });

  it("offers an update only when one is genuinely available", async () => {
    render(<Deployment api={apiWith({ phase: "ready", updateAvailable: true })} />);
    expect(await screen.findByRole("button", { name: "Update backend" })).toBeInTheDocument();
  });

  it("NEVER offers an update when the app is the outdated one — it explains instead", async () => {
    // The downgrade footgun: an older app must not roll a newer backend backwards.
    render(<Deployment api={apiWith({ phase: "ready", appOutdated: true, updateAvailable: false })} />);
    expect(await screen.findByText(/Update the app in\s+AgentsPoppy/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update backend" })).not.toBeInTheDocument();
  });

  it("requires an inline confirm before removing everything", async () => {
    const api = apiWith({ phase: "ready" });
    render(<Deployment api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove everything" }));
    expect(api.teardown).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Yes, remove everything" }));
    await waitFor(() => expect(api.teardown).toHaveBeenCalled());
  });

  it("lets the user back out of removal", async () => {
    const api = apiWith({ phase: "ready" });
    render(<Deployment api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Remove everything" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByText(/cannot be undone/)).not.toBeInTheDocument();
    expect(api.teardown).not.toHaveBeenCalled();
  });

  it("surfaces the root-cause reason on a failed stack, not just 'it failed'", async () => {
    render(
      <Deployment
        api={apiWith({
          phase: "failed",
          message: "The last setup attempt didn't finish and AWS undid it.",
          failureReason: "User is not authorized to perform: dynamodb:CreateTable",
        })}
      />,
    );
    expect(await screen.findByText(/dynamodb:CreateTable/)).toBeInTheDocument();
  });
});
