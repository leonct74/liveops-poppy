import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Titles } from "./Titles";
import { demoApi } from "./demo";
import type { Api } from "./api";

function apiWith(over: Partial<Api> = {}): Api {
  return {
    ...demoApi(),
    listTitles: vi.fn(async () => ({ titles: [] })),
    createTitle: vi.fn(async (name: string) => ({
      title: { titleId: "ab12cd34", name, createdAt: "2026-08-11T00:00:00Z", eventCap: 500_000, cardCap: 200 },
      key: "lop_live_SECRETKEY0123456789",
    })),
    ...over,
  };
}

describe("Titles", () => {
  /**
   * The key is shown EXACTLY once (only a hash is stored), so the reveal must be
   * impossible to miss. The founder's first run missed it entirely — it rendered below
   * the create form, off the bottom of the card, while the eye followed the new title
   * appearing in the list — and copied the title id instead (2026-08-11).
   */
  it("reveals the one-time key ABOVE the titles list, not buried under the form", async () => {
    render(<Titles api={apiWith()} />);
    await userEvent.type(screen.getByPlaceholderText("Sunken Keep"), "My First Game");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    const key = await screen.findByText("lop_live_SECRETKEY0123456789");
    expect(key).toBeInTheDocument();

    // It must precede the list in DOM order — that is what puts it in view.
    const card = key.closest(".card") ?? document.body;
    const keybox = key.closest(".keybox")!;
    const list = card.querySelector(".stack")!;
    expect(keybox.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says plainly that the key is one-time and is NOT the title id", async () => {
    render(<Titles api={apiWith()} />);
    await userEvent.type(screen.getByPlaceholderText("Sunken Keep"), "My First Game");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText(/only time this key is shown/i)).toBeInTheDocument();
    expect(screen.getByText(/not the title id/i)).toBeInTheDocument();
    expect(screen.getByText(/Rotate key/i)).toBeInTheDocument(); // the stated recovery
  });
});
