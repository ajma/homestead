import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { signOut, useSession } from "../lib/auth-client.js";
import { usePreflight } from "../lib/queries.js";
import { useMenu } from "../lib/use-menu.js";
import { PreflightBanner } from "./PreflightBanner.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { Button } from "./ui/Button.js";

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

const NAV_ITEMS: {
  to: string;
  label: string;
  icon: ReactNode;
  end: boolean;
}[] = [
  {
    to: "/",
    label: "Dashboard",
    end: true,
    icon: (
      <Glyph>
        <path d="M3 10.5 12 3l9 7.5" />
        <path d="M5 9.8V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.8" />
      </Glyph>
    ),
  },
  {
    to: "/projects",
    label: "Projects",
    end: false,
    icon: (
      <Glyph>
        <path d="M12 3 3 7.5l9 4.5 9-4.5z" />
        <path d="M3 12.5 12 17l9-4.5" />
        <path d="M3 17 12 21.5 21 17" />
      </Glyph>
    ),
  },
  {
    to: "/devices",
    label: "Devices",
    end: false,
    icon: (
      <Glyph>
        <rect x="5" y="2" width="14" height="20" rx="2" />
        <path d="M12 18h.01" />
      </Glyph>
    ),
  },
  {
    to: "/exposures",
    label: "Exposures",
    end: false,
    icon: (
      <Glyph>
        <path d="M3 3v18h18" />
        <path d="M18 9l-5 5-4-4-6 6" />
      </Glyph>
    ),
  },
];

// Icon-only navigation below sm: breakpoint (min-w-11 min-h-11 = 44×44 touch
// targets) fits any number of items in 390px without overflow. Labels remain
// accessible via aria-label on each NavLink.
const NAV_LINK =
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md px-2 text-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:px-3";

export function AppShell() {
  const { data } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const menu = useMenu();
  const menuId = useId();
  const emailId = useId();
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const preflight = usePreflight();

  // A closed menu takes its error with it, however it was closed: a retry must
  // not open onto the previous attempt's message.
  useEffect(() => {
    if (!menu.open) setSignOutError(null);
  }, [menu.open]);

  async function handleSignOut() {
    setSignOutError(null);
    // Better-Auth resolves with { error } rather than throwing. Navigating on a
    // failed sign-out would tell the user they are signed out while the server
    // session is still live — and Back would walk straight into the app.
    const { error } = await signOut();
    if (error) {
      setSignOutError(
        error.message ?? "Could not sign out. Check your connection.",
      );
      return;
    }
    menu.setOpen(false);
    navigate("/login");
    // Sign-out is a client-side transition, so every cached query would
    // otherwise survive into the next account's session on a shared device.
    // Cleared *after* navigating: clearing while a data page is still mounted
    // leaves its observer to re-fetch with the cookie the server has just
    // revoked, and apiFetch answers that 401 with window.location.assign —
    // a full page reload in place of the SPA transition.
    queryClient.clear();
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-border bg-surface">
        <div className="flex h-14 items-center justify-between gap-2 px-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-2 sm:gap-6">
            {/* The wordmark is the first thing to go at phone width: the two
                nav destinations and the account menu must stay reachable. */}
            <span className="hidden font-semibold text-text sm:inline">
              Homestead
            </span>
            <nav aria-label="Main" className="flex items-center gap-1">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  aria-label={item.label}
                  className={({ isActive }) =>
                    `${NAV_LINK} ${isActive ? "text-accent" : "text-text hover:text-accent"}`
                  }
                >
                  {item.icon}
                  <span className="hidden sm:inline">{item.label}</span>
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-1 sm:gap-2">
            <ThemeToggle />
            <div className="relative">
              <Button
                ref={menu.triggerRef}
                variant="ghost"
                // The label is on the button, not the text node, so the
                // accessible name survives the label being hidden on phones.
                aria-label="Account"
                aria-haspopup="menu"
                aria-expanded={menu.open}
                aria-controls={menu.open ? menuId : undefined}
                onClick={() => menu.setOpen(!menu.open)}
                onKeyDown={menu.onTriggerKeyDown}
                className="min-w-11"
              >
                <Glyph>
                  <circle cx="12" cy="8" r="3.5" />
                  <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
                </Glyph>
                <span className="hidden sm:inline">Account</span>
              </Button>
              {menu.open && (
                <div
                  ref={menu.popoverRef}
                  className="absolute right-0 top-full mt-1 w-64 rounded-md border border-border bg-raised shadow-lg"
                >
                  {/* Outside the role="menu": a menu may only contain
                      menuitem/group/separator children. */}
                  <p
                    id={emailId}
                    className="border-b border-border px-3 py-2 text-sm text-muted"
                  >
                    {data?.user.email}
                  </p>
                  <div
                    id={menuId}
                    ref={menu.menuRef}
                    role="menu"
                    aria-labelledby={emailId}
                    onKeyDown={menu.onMenuKeyDown}
                    className="py-1"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={handleSignOut}
                      className="flex min-h-11 w-full items-center px-3 text-left text-sm text-text transition hover:bg-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                    >
                      Sign out
                    </button>
                  </div>
                  {signOutError && (
                    <p
                      role="alert"
                      className="border-t border-border px-3 py-2 text-sm text-danger"
                    >
                      {signOutError}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </header>
      <PreflightBanner checks={preflight.data ?? []} />
      <Outlet />
    </div>
  );
}
