import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "./ThemeToggle.js";

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

async function openMenu() {
  await userEvent.click(screen.getByRole("button", { name: /theme/i }));
}

describe("ThemeToggle", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    stubMatchMedia(false);
  });

  it("shows the stored scheme in the trigger name and checks it in the menu", async () => {
    localStorage.setItem("homestead.color-scheme", "dark");
    render(<ThemeToggle />);

    expect(
      screen.getByRole("button", { name: /theme: dark/i }),
    ).toBeInTheDocument();

    await openMenu();
    expect(screen.getByRole("menuitemradio", { name: "Dark" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByRole("menuitemradio", { name: "Light" }),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("marks the newly selected scheme as active", async () => {
    render(<ThemeToggle />);
    await openMenu();
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Dark" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("homestead.color-scheme")).toBe("dark");
    expect(
      screen.getByRole("button", { name: /theme: dark/i }),
    ).toBeInTheDocument();

    await openMenu();
    expect(screen.getByRole("menuitemradio", { name: "Dark" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("moves focus into the menu and roves with the arrow keys", async () => {
    render(<ThemeToggle />);
    await openMenu();

    expect(screen.getByRole("menuitemradio", { name: "Light" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemradio", { name: "Dark" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("menuitemradio", { name: "System" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemradio", { name: "Light" })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitemradio", { name: "System" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("menuitemradio", { name: "Light" })).toHaveFocus();
  });

  it("opens on the last item when the trigger is opened with ArrowUp", async () => {
    render(<ThemeToggle />);
    screen.getByRole("button", { name: /theme/i }).focus();

    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitemradio", { name: "System" })).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemradio", { name: "Light" })).toHaveFocus();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    render(<ThemeToggle />);
    await openMenu();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /theme/i })).toHaveFocus();
  });

  it("closes on an outside click", async () => {
    render(
      <div>
        <ThemeToggle />
        <button type="button">elsewhere</button>
      </div>,
    );
    await openMenu();

    await userEvent.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("returns focus to the trigger when an outside click leaves it nowhere", async () => {
    render(
      <div>
        <ThemeToggle />
        <p>just some text</p>
      </div>,
    );
    await openMenu();

    await userEvent.click(screen.getByText("just some text"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /theme/i })).toHaveFocus();
  });
});
