// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { AppIcon } from "@web/components/AppIcon";
import { describe, expect, it } from "vitest";

describe("AppIcon", () => {
  it("renders a letter tile when there is no icon reference", () => {
    render(<AppIcon iconRef={null} displayName="Jellyfin" />);
    expect(screen.getByText("J")).toBeTruthy();
  });

  it("loads the icon through Homestead's own proxy, never a CDN", () => {
    // The privacy property: a viewer's browser must not tell jsDelivr what runs here.
    render(<AppIcon iconRef="jellyfin" displayName="Jellyfin" />);
    const img = screen.getByRole("img", { name: "Jellyfin" }) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/icons/jellyfin.svg");
    expect(img.getAttribute("src")).not.toContain("jsdelivr");
  });

  it("falls back to the letter tile when the image fails to load", () => {
    render(<AppIcon iconRef="broken" displayName="Plex" />);
    fireEvent.error(screen.getByRole("img", { name: "Plex" }));
    expect(screen.getByText("P")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("uses the first letter of a name that starts with a digit or symbol", () => {
    render(<AppIcon iconRef={null} displayName="2fauth" />);
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("renders a stable placeholder for an empty name rather than an empty box", () => {
    render(<AppIcon iconRef={null} displayName="" />);
    expect(screen.getByText("?")).toBeTruthy();
  });

  it("gives the same name the same tile colour on every render", () => {
    const { container: a } = render(<AppIcon iconRef={null} displayName="Jellyfin" />);
    const { container: b } = render(<AppIcon iconRef={null} displayName="Jellyfin" />);
    expect(a.firstElementChild?.className).toBe(b.firstElementChild?.className);
  });
});
