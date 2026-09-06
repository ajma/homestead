import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Anything that behaves as a menu item for roving focus. `menuitemradio` is
 * included because the theme menu picks exactly one of three options.
 */
const ITEM_SELECTOR =
  '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';

/**
 * The keyboard and dismissal contract for a WAI-ARIA menu button.
 *
 * Announcing `role="menu"` obliges us to move focus into the menu when it
 * opens and to support Up/Down/Home/End inside it — a trigger that opens a
 * menu but keeps focus on itself strands keyboard and screen-reader users.
 * Escape and outside click close the menu; Escape returns focus to the trigger.
 */
export function useMenu() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** The whole popover, including anything outside the `role="menu"` element. */
  const popoverRef = useRef<HTMLDivElement>(null);
  /** The `role="menu"` element itself; its items receive roving focus. */
  const menuRef = useRef<HTMLDivElement>(null);

  const items = useCallback(
    () =>
      Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [],
      ),
    [],
  );

  const close = useCallback((focusTrigger = true) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
  }, [open, items]);

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }

    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (
        popoverRef.current &&
        triggerRef.current &&
        !popoverRef.current.contains(target) &&
        !triggerRef.current.contains(target)
      ) {
        close(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open, close]);

  /** ArrowDown/ArrowUp on a closed menu button opens it (focus follows on open). */
  function onTriggerKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const els = items();
    if (els.length === 0) return;
    const current = els.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    switch (e.key) {
      case "ArrowDown":
        next = current < 0 ? 0 : (current + 1) % els.length;
        break;
      case "ArrowUp":
        next =
          current < 0
            ? els.length - 1
            : (current - 1 + els.length) % els.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = els.length - 1;
        break;
    }
    if (next === null) return;
    e.preventDefault();
    els[next]?.focus();
  }

  return {
    open,
    setOpen,
    close,
    triggerRef,
    popoverRef,
    menuRef,
    onTriggerKeyDown,
    onMenuKeyDown,
  };
}
