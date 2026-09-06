import { type KeyboardEvent, useRef } from "react";
import { NavLink } from "react-router-dom";

interface TabItem {
  id: string;
  label: string;
  href: string;
}

interface TabsProps {
  items: TabItem[];
  activeId: string;
}

export function Tabs({ items, activeId }: TabsProps) {
  const tabsRef = useRef<Map<string, HTMLAnchorElement>>(new Map());

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = items.findIndex((item) => item.id === activeId);
    let targetIndex: number | null = null;

    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        targetIndex = (currentIndex + 1) % items.length;
        break;
      case "ArrowLeft":
        e.preventDefault();
        targetIndex = (currentIndex - 1 + items.length) % items.length;
        break;
      case "Home":
        e.preventDefault();
        targetIndex = 0;
        break;
      case "End":
        e.preventDefault();
        targetIndex = items.length - 1;
        break;
    }

    if (targetIndex !== null) {
      const targetItem = items[targetIndex];
      if (targetItem) {
        const targetTab = tabsRef.current.get(targetItem.id);
        targetTab?.focus();
      }
    }
  };

  return (
    <div
      role="tablist"
      onKeyDown={handleKeyDown}
      className="flex gap-1 border-b border-border overflow-x-auto"
      style={{ scrollbarWidth: "none" }}
    >
      {items.map((item) => {
        const isActive = item.id === activeId;
        return (
          <NavLink
            key={item.id}
            to={item.href}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            ref={(el) => {
              if (el) {
                tabsRef.current.set(item.id, el);
              } else {
                tabsRef.current.delete(item.id);
              }
            }}
            className={`
              min-h-11 px-4 py-2 text-sm font-medium whitespace-nowrap
              border-b-2 transition
              focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent
              ${
                isActive
                  ? "border-accent text-accent"
                  : "border-transparent text-muted hover:text-text hover:border-border"
              }
            `}
          >
            {item.label}
          </NavLink>
        );
      })}
    </div>
  );
}
