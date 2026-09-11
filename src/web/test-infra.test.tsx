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

it("second test does not see it, proving cleanup actually runs", () => {
  // Without `afterEach(cleanup)` this passes for the wrong reason forever: the
  // previous test's node is still mounted and `alpha` would still be found.
  renderWithQuery(<p>beta</p>);
  expect(screen.queryAllByText("alpha")).toHaveLength(0);
});
