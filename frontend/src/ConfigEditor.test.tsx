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
  /**
   * A first-time user faces an empty box and no idea what to write — the founder's own
   * first run stalled exactly here (2026-08-11). The honest answer ("any JSON object,
   * they're YOUR settings, we never interpret them") is precisely what a blank textarea
   * can't say, so the unpublished state must teach it AND offer a starting point.
   */
  const emptyApi = (over: Partial<Api> = {}) =>
    editorApi({
      getConfig: vi.fn(async () => ({ env: "prod" as const, version: 0, json: "{}" })),
      configHistory: vi.fn(async () => ({ versions: [] })),
      ...over,
    });

  it("explains what a config document is when nothing is published yet", async () => {
    render(<ConfigEditor api={emptyApi()} titleId="abcd1234" />);
    expect(await screen.findByText(/yours to invent/i)).toBeInTheDocument();
    expect(screen.getByText(/never interprets it/i)).toBeInTheDocument();
    expect(screen.getByText(/by name, with a fallback/i)).toBeInTheDocument();
  });

  it("fills the editor with a working example on request", async () => {
    render(<ConfigEditor api={emptyApi()} titleId="abcd1234" />);
    await userEvent.click(await screen.findByRole("button", { name: "Start from an example" }));

    const box = screen.getByLabelText("Config document") as HTMLTextAreaElement;
    const parsed = JSON.parse(box.value);
    expect(parsed.balance.shotgunDamage).toBe(34);
    expect(parsed.shop.weekendSaleActive).toBe(false);
    expect(validate(box.value)).toBeNull(); // publishable as-is
  });

  it("teaches nothing once a config exists — the guidance is for the empty state only", async () => {
    render(<ConfigEditor api={editorApi()} titleId="abcd1234" />);
    await screen.findByLabelText("Config document");
    expect(screen.queryByText(/yours to invent/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start from an example" })).not.toBeInTheDocument();
  });

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
