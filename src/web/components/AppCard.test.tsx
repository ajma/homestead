// @vitest-environment jsdom
import type { LauncherApp } from "@shared/launcher";
import { fireEvent, render, screen } from "@testing-library/react";
import { AppCard } from "@web/components/AppCard";
import { describe, expect, it, vi } from "vitest";

const tile = (over: Partial<LauncherApp> = {}): LauncherApp => ({
  id: "a1",
  slug: "jellyfin",
  displayName: "Jellyfin",
  description: "Media server",
  iconRef: "jellyfin",
  category: "Media",
  launchUrl: "http://nas:8096",
  sortOrder: 0,
  status: "up",
  reason: "Healthy",
  since: null,
  probes: [],
  ...over,
});

describe("AppCard", () => {
  it("links to the launch URL", () => {
    render(<AppCard app={tile()} onOpenHealth={() => {}} />);
    expect(screen.getByRole("link", { name: /Jellyfin/ }).getAttribute("href")).toBe(
      "http://nas:8096",
    );
  });

  it("stays clickable but visibly dimmed when down", () => {
    // Spec: greying out a tile because a probe failed is maddening when the probe is
    // what is broken. Dimmed, not disabled.
    render(
      <AppCard
        app={tile({ status: "down", reason: "Containers not running" })}
        onOpenHealth={() => {}}
      />,
    );
    const link = screen.getByRole("link", { name: /Jellyfin/ });
    expect(link.getAttribute("href")).toBe("http://nas:8096");
    expect(link.getAttribute("aria-disabled")).toBeNull();
    expect(link.className).toContain("opacity-");
  });

  it("renders a non-link card when the app has no launch URL", () => {
    render(<AppCard app={tile({ launchUrl: null })} onOpenHealth={() => {}} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Jellyfin")).toBeTruthy();
  });

  it("opens health from the chip without following the launch link", () => {
    const onOpenHealth = vi.fn();
    const followed = vi.fn();
    render(<AppCard app={tile()} onOpenHealth={onOpenHealth} />);
    screen.getByRole("link", { name: /Jellyfin/ }).addEventListener("click", followed);
    fireEvent.click(screen.getByRole("button", { name: /Show health details/ }));
    expect(onOpenHealth).toHaveBeenCalledWith("a1");
    expect(followed).not.toHaveBeenCalled();
  });

  it("opens in a new tab without leaking the referrer to the target app", () => {
    render(<AppCard app={tile()} onOpenHealth={() => {}} />);
    const link = screen.getByRole("link", { name: /Jellyfin/ });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });
});
