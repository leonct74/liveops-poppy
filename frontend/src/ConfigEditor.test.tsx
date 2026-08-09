import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfigEditor, validate } from "./ConfigEditor";
import { demoApi } from "./demo";
import type { Api } from "./api";

describe("validate (mirrors the server rule)", () => {
  it("accepts a JSON object and rejects everything else", () => {
    expect(validate('{"a":1}')).toBeNull();
    expect(validate("nope")).toMatch(/isn't valid JSON/);
    expect(validate("[1,2]")).toMatch(/must be a JSON object/);
    expect(validate("42")).toMatch(/must be a JSON object/);
  });
});

function editorApi(over: Partial<Api> = {}): Api {
  return {
    ...demoApi(),
    getConfig: vi.fn(async () => ({ env: "prod" as const, version: 3, json: '{"speed":1}' })),
    configHistory: vi.fn(async () => ({
      versions: [
        { version: 3, publishedAt: "2026-08-08T00:00:00Z", note: "live" },
        { version: 2, publishedAt: "2026-08-01T00:00:00Z", note: "older" },
      ],
    })),
    publishConfig: vi.fn(async () => ({ env: "prod" as const, version: 4, json: "{}" })),
    rollbackConfig: vi.fn(async () => ({ env: "prod" as const, version: 2, json: "{}" })),
    ...over,
  };
}

describe("ConfigEditor", () => {
  it("requires an inline confirm before publishing — a publish reaches live players", async () => {
    const api = editorApi();
    render(<ConfigEditor api={api} titleId="abcd1234" />);
    const box = await screen.findByLabelText("Config document");

    await userEvent.clear(box);
    await userEvent.type(box, '{{"speed":2}');
    await userEvent.click(screen.getByRole("button", { name: /Publish to prod/ }));

    // Nothing has been sent yet — the confirm explains the blast radius first.
    expect(api.publishConfig).not.toHaveBeenCalled();
    expect(screen.getByText(/reaches every player/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Publish v4/ }));
    await waitFor(() => expect(api.publishConfig).toHaveBeenCalled());
  });

  it("won't offer to publish an invalid document", async () => {
    render(<ConfigEditor api={editorApi()} titleId="abcd1234" />);
    const box = await screen.findByLabelText("Config document");
    await userEvent.clear(box);
    await userEvent.type(box, "not json");
    expect(await screen.findByText(/isn't valid JSON/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Publish to prod/ })).toBeDisabled();
  });

  it("won't offer to publish an unchanged document", async () => {
    render(<ConfigEditor api={editorApi()} titleId="abcd1234" />);
    await screen.findByLabelText("Config document");
    expect(screen.getByRole("button", { name: /Publish to prod/ })).toBeDisabled();
  });

  it("offers rollback for older versions but not for the live one", async () => {
    render(<ConfigEditor api={editorApi()} titleId="abcd1234" />);
    await screen.findByText("v2");
    // Exactly one rollback button: v2. v3 is live, so it has none.
    expect(screen.getAllByRole("button", { name: "Roll back" })).toHaveLength(1);
  });

  it("hides every mutating control in read-only (demo) mode", async () => {
    render(<ConfigEditor api={editorApi()} titleId="abcd1234" readOnly />);
    await screen.findByLabelText("Config document");
    expect(screen.queryByRole("button", { name: /Publish to prod/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Roll back" })).not.toBeInTheDocument();
  });
});
