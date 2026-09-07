import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { EnvEditor } from "./EnvEditor.js";

const FILE = `# get this from the admin panel
DB_PASSWORD=hunter2
TZ=Europe/London
`;

const base = { onChange: () => {}, onSave: () => {}, dirty: false };

describe("EnvEditor", () => {
  // CodeMirror needs real DOM measurement APIs that jsdom lacks.
  beforeAll(() => {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* () {},
      }) as DOMRectList;
    Range.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    });
  });

  it("shows one row per entry and hides comments from the form", async () => {
    render(<EnvEditor {...base} value={FILE} />);
    expect(screen.getByDisplayValue("DB_PASSWORD")).toBeInTheDocument();
    expect(screen.getByDisplayValue("TZ")).toBeInTheDocument();
  });

  it("masks a secret-looking value until revealed", async () => {
    const user = userEvent.setup();
    render(<EnvEditor {...base} value={FILE} />);
    const secret = screen.getByLabelText("Value for DB_PASSWORD");
    expect(secret).toHaveAttribute("type", "password");
    expect(secret).toHaveValue("hunter2");
    await user.click(screen.getByRole("button", { name: /show DB_PASSWORD/i }));
    expect(secret).toHaveAttribute("type", "text");
    expect(secret).toHaveValue("hunter2");
  });

  it("does not mask an ordinary setting", () => {
    render(<EnvEditor {...base} value={FILE} />);
    expect(screen.getByLabelText("Value for TZ")).toHaveAttribute(
      "type",
      "text",
    );
  });

  it("preserves comments when a value is edited", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function Wrapper() {
      const [value, setValue] = useState(FILE);
      return (
        <EnvEditor
          {...base}
          value={value}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      );
    }
    render(<Wrapper />);
    const input = screen.getByLabelText("Value for TZ");
    await user.clear(input);
    await user.type(input, "UTC");
    const next = onChange.mock.calls.at(-1)?.[0] as string;
    expect(next).toContain("# get this from the admin panel");
    expect(next).toContain("TZ=UTC");
    expect(next).toContain("DB_PASSWORD=hunter2");
  });

  it("offers to create the file when there is none", () => {
    render(<EnvEditor {...base} value={null} />);
    expect(
      screen.getByRole("button", { name: /create .env/i }),
    ).toBeInTheDocument();
  });

  it("keeps unmodelled lines reachable through the raw view", async () => {
    const user = userEvent.setup();
    const weird = 'MULTI="line one\nline two"\n';
    render(<EnvEditor {...base} value={weird} />);
    await user.click(screen.getByRole("radio", { name: /raw/i }));
    expect(await screen.findByText(/line two/)).toBeInTheDocument();
  });

  it("rejects a key that compose cannot use", async () => {
    const user = userEvent.setup();
    render(<EnvEditor {...base} value={"A=1\n"} />);
    const button = screen.getByRole("button", { name: /add variable/i });
    const key = screen.getByLabelText(/key for the new variable/i);
    await user.type(key, "2BAD KEY");
    const error = await screen.findByText(/letters, digits and underscores/i);
    expect(error).toBeInTheDocument();
    expect(button).toBeDisabled();
    expect(key).toHaveAccessibleDescription(/letters, digits and underscores/i);
  });

  it("handles duplicate keys correctly", async () => {
    const duplicate = "KEY=first\nKEY=second\n";
    render(<EnvEditor {...base} value={duplicate} />);

    const inputs = screen.getAllByDisplayValue("KEY");
    expect(inputs).toHaveLength(2);

    // First occurrence should be labeled as such
    expect(
      screen.getByLabelText(/Key KEY \(occurrence 1 of 2\)/i),
    ).toBeInTheDocument();

    // Last occurrence should be marked as the one compose uses
    expect(
      screen.getByLabelText(/Key KEY \(last, used by compose\)/i),
    ).toBeInTheDocument();

    // Both remove buttons should indicate they remove all occurrences
    const removeButtons = screen.getAllByRole("button", {
      name: /Remove KEY \(all 2 occurrences\)/i,
    });
    expect(removeButtons).toHaveLength(2);
  });

  it("preserves all lines across a multi-step editing sequence", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const initial = `# comment
A=1
B=2
C=3
`;
    function Wrapper() {
      const [value, setValue] = useState(initial);
      return (
        <EnvEditor
          {...base}
          value={value}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      );
    }
    render(<Wrapper />);

    // Step 1: Edit A
    await user.clear(screen.getByLabelText("Value for A"));
    await user.type(screen.getByLabelText("Value for A"), "changed");

    // Step 2: Add a new variable
    await user.type(screen.getByLabelText(/key for the new variable/i), "D");
    await user.click(screen.getByRole("button", { name: /add variable/i }));

    // Step 3: Remove B
    await user.click(screen.getByRole("button", { name: /Remove B/i }));

    // Step 4: Edit C
    await user.clear(screen.getByLabelText("Value for C"));
    await user.type(screen.getByLabelText("Value for C"), "also-changed");

    const final = onChange.mock.calls.at(-1)?.[0] as string;
    expect(final).toContain("# comment");
    expect(final).toContain("A=changed");
    expect(final).not.toContain("B=");
    expect(final).toContain("C=also-changed");
    expect(final).toContain("D=");
  });

  it("creates a valid file from empty state", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function Wrapper() {
      const [value, setValue] = useState<string | null>(null);
      return (
        <EnvEditor
          {...base}
          value={value}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      );
    }
    render(<Wrapper />);

    // Create the file
    await user.click(screen.getByRole("button", { name: /create .env/i }));

    // Add first variable
    await user.type(
      screen.getByLabelText(/key for the new variable/i),
      "FIRST",
    );
    await user.click(screen.getByRole("button", { name: /add variable/i }));
    await user.type(screen.getByLabelText("Value for FIRST"), "value");

    const result = onChange.mock.calls.at(-1)?.[0] as string;
    expect(result).not.toBe("undefined");
    expect(result).toBe("FIRST=value\n");
  });
});
