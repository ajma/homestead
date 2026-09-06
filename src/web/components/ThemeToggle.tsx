import { type ReactNode, useEffect, useId, useState } from "react";
import {
  applyScheme,
  type ColorScheme,
  readStoredScheme,
  resolveScheme,
  storeScheme,
} from "../lib/theme.js";
import { useMenu } from "../lib/use-menu.js";
import { IconButton } from "./ui/IconButton.js";

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const SCHEMES: Record<ColorScheme, { label: string; icon: ReactNode }> = {
  light: {
    label: "Light",
    icon: (
      <Glyph>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
      </Glyph>
    ),
  },
  dark: {
    label: "Dark",
    icon: (
      <Glyph>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </Glyph>
    ),
  },
  system: {
    label: "System",
    icon: (
      <Glyph>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </Glyph>
    ),
  },
};

const ORDER: ColorScheme[] = ["light", "dark", "system"];

export function ThemeToggle() {
  const [scheme, setScheme] = useState<ColorScheme>("system");
  const menu = useMenu();
  const menuId = useId();

  useEffect(() => {
    setScheme(readStoredScheme());
  }, []);

  function selectScheme(newScheme: ColorScheme) {
    setScheme(newScheme);
    storeScheme(newScheme);
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    applyScheme(
      resolveScheme(newScheme === "system" ? null : newScheme, prefersDark),
    );
    menu.close();
  }

  const active = SCHEMES[scheme];

  return (
    <div className="relative">
      <IconButton
        ref={menu.triggerRef}
        // The active scheme belongs in the accessible name: with an icon-only
        // trigger it is otherwise impossible to tell which one is in force.
        label={`Theme: ${active.label}`}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menu.open ? menuId : undefined}
        onClick={() => menu.setOpen(!menu.open)}
        onKeyDown={menu.onTriggerKeyDown}
      >
        {active.icon}
      </IconButton>
      {menu.open && (
        <div
          ref={menu.popoverRef}
          className="absolute right-0 top-full mt-1 w-44 rounded-md border border-border bg-raised shadow-lg"
        >
          <div
            id={menuId}
            ref={menu.menuRef}
            role="menu"
            aria-label="Colour scheme"
            onKeyDown={menu.onMenuKeyDown}
            className="py-1"
          >
            {ORDER.map((id) => (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={scheme === id}
                onClick={() => selectScheme(id)}
                className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm text-text transition hover:bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
              >
                <span aria-hidden="true" className="w-3 text-accent">
                  {scheme === id ? "✓" : ""}
                </span>
                {SCHEMES[id].icon}
                <span>{SCHEMES[id].label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
