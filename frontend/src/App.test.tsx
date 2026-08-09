import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App";

describe("App (P0 hello screen)", () => {
  it("renders the brand and the no-resources reassurance", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "LiveOpsPoppy" })).toBeInTheDocument();
    expect(screen.getByText(/No AWS resources are created by this build/)).toBeInTheDocument();
  });
});
