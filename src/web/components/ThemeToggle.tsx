import { useEffect, useRef, useState } from "react";
import {
  applyScheme,
  type ColorScheme,
  readStoredScheme,
  resolveScheme,
  storeScheme,
} from "../lib/theme.js";

export function ThemeToggle() {
  const [open, setOpen] = useState(false);
  const [_scheme, setScheme] = useState<ColorScheme>("system");
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setScheme(readStoredScheme());
  }, []);

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }

    function handleClickOutside(e: MouseEvent) {
      if (
        menuRef.current &&
        buttonRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open]);

  function selectScheme(newScheme: ColorScheme) {
    setScheme(newScheme);
    storeScheme(newScheme);
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    applyScheme(
      resolveScheme(newScheme === "system" ? null : newScheme, prefersDark),
    );
    setOpen(false);
    buttonRef.current?.focus();
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded-md px-3 py-2 text-sm text-text hover:bg-raised transition"
      >
        Theme
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          className="absolute right-0 top-full mt-1 w-32 rounded-md border border-border bg-raised shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => selectScheme("light")}
            className="w-full px-3 py-2 text-left text-sm text-text hover:bg-surface transition"
          >
            Light
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => selectScheme("dark")}
            className="w-full px-3 py-2 text-left text-sm text-text hover:bg-surface transition"
          >
            Dark
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => selectScheme("system")}
            className="w-full px-3 py-2 text-left text-sm text-text hover:bg-surface transition"
          >
            System
          </button>
        </div>
      )}
    </div>
  );
}
