// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { renderWithQuery } from "@web/test-setup";
import { expect, it } from "vitest";

it("has a DOM global", () => {
  expect(typeof document).toBe("object");
});

it("first test leaves a node behind", () => {
  renderWithQuery(<p>alpha</p>);
  expect(screen.getByText("alpha")).toBeTruthy();
});

it("second test does not see the first test's node, so some cleanup is running", () => {
  // Deliberately does not claim *which* cleanup. Measured: removing the explicit
  // `afterEach(cleanup)` from test-setup leaves this green, because RTL registers its
  // own on import. This test guards the property — a stale DOM makes `getByText` match
  // a node the previous test rendered — not any one implementation of it.
  renderWithQuery(<p>beta</p>);
  expect(screen.queryAllByText("alpha")).toHaveLength(0);
});
