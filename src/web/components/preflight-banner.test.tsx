import type { PreflightResult } from "@shared/preflight.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PreflightBanner } from "./PreflightBanner.js";

const pass = (id: string): PreflightResult => ({
  id,
  label: `${id} is fine`,
  ok: true,
  detail: "no problem here",
  severity: "warning",
});

const fail = (
  id: string,
  detail: string,
  severity: PreflightResult["severity"] = "warning",
): PreflightResult => ({
  id,
  label: `${id} failed`,
  ok: false,
  detail,
  severity,
});

describe("PreflightBanner", () => {
  it("renders nothing when every check passes", () => {
    const { container } = render(
      <PreflightBanner
        checks={[pass("docker_reachable"), pass("port_free")]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when there are no checks at all", () => {
    // A viewer's request 403s, so the banner receives an empty array.
    const { container } = render(<PreflightBanner checks={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows both the label and the detail of a failed check", () => {
    // The label says what is wrong; only the detail says where.
    render(
      <PreflightBanner
        checks={[
          fail("docker_reachable", "/var/run/docker.sock: no such file"),
        ]}
      />,
    );
    expect(screen.getByText(/docker_reachable failed/)).toBeVisible();
    expect(screen.getByText(/no such file/)).toBeVisible();
  });

  it("shows every failed check, not just the first", () => {
    // Two things are wrong on a fresh misconfigured box more often than one,
    // and fixing only the one you were shown means another restart to learn
    // about the next.
    render(
      <PreflightBanner
        checks={[
          fail("docker_reachable", "socket unreachable"),
          pass("compose_v2"),
          fail("projects_dir_readable", "/opt/stacks is unreadable"),
        ]}
      />,
    );
    expect(screen.getByText(/socket unreachable/)).toBeVisible();
    expect(screen.getByText(/opt\/stacks is unreadable/)).toBeVisible();
    expect(screen.queryByText(/no problem here/)).toBeNull();
  });

  it("distinguishes a danger check from a warning", () => {
    // Silent corruption and a failed action are not the same news, and the
    // spec calls the network-filesystem case out as different in kind.
    render(
      <PreflightBanner
        checks={[
          fail("docker_reachable", "socket unreachable"),
          fail(
            "data_dir_local_fs",
            "/data is on nfs4; data loss is possible",
            "danger",
          ),
        ]}
      />,
    );
    const warn = screen.getByText(/socket unreachable/);
    const danger = screen.getByText(/data loss is possible/);
    expect(danger).toBeVisible();
    expect(danger.className).not.toBe(warn.className);
  });

  it("names itself for screen readers as an alert", () => {
    render(
      <PreflightBanner
        checks={[fail("port_free", "port 7420 is already in use")]}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/7420/);
  });
});
