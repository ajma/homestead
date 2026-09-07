import { useId } from "react";

interface SegmentedControlItem {
  id: string;
  label: string;
}

interface SegmentedControlProps {
  items: SegmentedControlItem[];
  value: string;
  onChange: (value: string) => void;
}

export function SegmentedControl({
  items,
  value,
  onChange,
}: SegmentedControlProps) {
  // `useId`, not `Math.random()`: the name has to be the same string on every
  // render and on both of StrictMode's paired renders, or the radio group and
  // its `htmlFor` links are rebuilt from under the user each time the parent
  // re-renders.
  const groupName = `segmented-control-${useId()}`;

  return (
    <div
      role="radiogroup"
      className="inline-flex gap-1 p-1 bg-raised border border-border rounded-lg"
    >
      {items.map((item) => {
        const isChecked = item.id === value;
        const inputId = `${groupName}-${item.id}`;
        return (
          <label
            key={item.id}
            htmlFor={inputId}
            className={`
              relative inline-flex min-h-11 items-center justify-center px-4 py-2 text-sm font-medium rounded-md transition cursor-pointer
              focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent
              ${
                isChecked
                  ? "bg-surface text-text shadow-sm"
                  : "text-muted hover:text-text"
              }
            `}
          >
            {/* Transparent and stretched over the label, not `sr-only`.
                `sr-only` renders a 1×1 box: the tap-target sweep measured the
                radio itself and reported an 8px control, and every pointer
                event landed on the label instead of the input, so Playwright
                could never click it. Filling the label makes the real hit area
                and the element's own box the same 44px rectangle, which is
                what both the sweep and a thumb are actually asking about. */}
            <input
              type="radio"
              id={inputId}
              name={groupName}
              value={item.id}
              checked={isChecked}
              onChange={() => onChange(item.id)}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
            {item.label}
          </label>
        );
      })}
    </div>
  );
}
