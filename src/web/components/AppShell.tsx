import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useNavigate } from "react-router-dom";
import { signOut, useSession } from "../lib/auth-client.js";
import { ThemeToggle } from "./ThemeToggle.js";

export function AppShell() {
  const { data } = useSession();
  const navigate = useNavigate();
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!accountMenuOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setAccountMenuOpen(false);
        accountButtonRef.current?.focus();
      }
    }

    function handleClickOutside(e: MouseEvent) {
      if (
        accountMenuRef.current &&
        accountButtonRef.current &&
        !accountMenuRef.current.contains(e.target as Node) &&
        !accountButtonRef.current.contains(e.target as Node)
      ) {
        setAccountMenuOpen(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [accountMenuOpen]);

  async function handleSignOut() {
    await signOut();
    setAccountMenuOpen(false);
    navigate("/login");
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-border bg-base">
        <div className="flex h-14 items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <span className="font-semibold text-text">Homestead</span>
            <nav className="flex gap-4">
              <Link
                to="/"
                className="text-sm text-text hover:text-accent transition"
              >
                Dashboard
              </Link>
              <Link
                to="/projects"
                className="text-sm text-text hover:text-accent transition"
              >
                Projects
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <div className="relative">
              <button
                ref={accountButtonRef}
                type="button"
                onClick={() => setAccountMenuOpen(!accountMenuOpen)}
                aria-haspopup="menu"
                aria-expanded={accountMenuOpen}
                className="rounded-md px-3 py-2 text-sm text-text hover:bg-raised transition"
              >
                Account
              </button>
              {accountMenuOpen && (
                <div
                  ref={accountMenuRef}
                  role="menu"
                  className="absolute right-0 top-full mt-1 w-56 rounded-md border border-border bg-raised shadow-lg"
                >
                  <div className="px-3 py-2 text-sm text-muted border-b border-border">
                    {data?.user.email}
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={handleSignOut}
                    className="w-full px-3 py-2 text-left text-sm text-text hover:bg-surface transition"
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
