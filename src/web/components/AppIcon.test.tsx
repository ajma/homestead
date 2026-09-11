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
    const { container } = render(<AppIcon iconRef="jellyfin" displayName="Jellyfin" />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/api/icons/jellyfin.svg");
    expect(img?.getAttribute("src")).not.toContain("jsdelivr");
  });

  it("is decorative, since the display name is rendered as text beside it", () => {
    // Queried by tag rather than by role: an empty `alt` is what makes it decorative, and
    // that is exactly what removes it from the accessibility tree. A non-empty alt here
    // makes a screen reader announce "Jellyfin, image, Jellyfin".
    const { container } = render(<AppIcon iconRef="jellyfin" displayName="Jellyfin" />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("falls back to the letter tile when the image fails to load", () => {
    const { container } = render(<AppIcon iconRef="broken" displayName="Plex" />);
    const img = container.querySelector("img");
    if (!img) throw new Error("expected an img before the error");
    fireEvent.error(img);
    expect(screen.getByText("P")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
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
