import { scaffoldCloudflared } from "@server/cloudflare/scaffold-cloudflared";
import { maskEnv, parseEnv, serialiseEnv } from "@shared/env-file";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("scaffoldCloudflared", () => {
  it("produces a compose file that parses as YAML", () => {
    const { composeFile } = scaffoldCloudflared();
    const parsed = parse(composeFile);
    expect(parsed.services.cloudflared).toBeDefined();
  });

  it("runs with network_mode: host", () => {
    const { composeFile } = scaffoldCloudflared();
    const parsed = parse(composeFile);
    expect(parsed.services.cloudflared.network_mode).toBe("host");
  });

  it("runs tunnel --no-autoupdate run", () => {
    const { composeFile } = scaffoldCloudflared();
    const parsed = parse(composeFile);
    expect(parsed.services.cloudflared.command).toBe("tunnel --no-autoupdate run");
  });

  it("interpolates TUNNEL_TOKEN from the environment rather than inlining a value", () => {
    const { composeFile } = scaffoldCloudflared();
    const parsed = parse(composeFile);
    // Interpolation syntax, not a literal value baked into the compose file.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal YAML text, not building a template string
    const expected = "${TUNNEL_TOKEN}";
    expect(String(parsed.services.cloudflared.environment.TUNNEL_TOKEN)).toBe(expected);
    // Nothing that looks like an actual secret value made it into the file at all.
    expect(composeFile).not.toMatch(/TUNNEL_TOKEN:\s*[^$\s]/);
  });

  it("returns an .env whose TUNNEL_TOKEN round-trips through parseEnv/serialiseEnv", () => {
    const { envFile } = scaffoldCloudflared();
    expect(envFile).toBe("TUNNEL_TOKEN=\n");
    const entries = parseEnv(envFile);
    const pair = entries.find((e) => e.kind === "pair" && e.key === "TUNNEL_TOKEN");
    expect(pair).toBeDefined();
    expect(serialiseEnv(entries)).toBe(envFile);
  });

  it("maskEnv masks TUNNEL_TOKEN once a real value is present", () => {
    // The scaffold's own placeholder is empty (see above) — this proves the masking
    // machinery itself treats TUNNEL_TOKEN like any other secret once the provisioning
    // step (not this function) writes the real value in, rather than assuming it.
    const entries = parseEnv("TUNNEL_TOKEN=cf-tunnel-token-abc123\n");
    expect(maskEnv(entries)).toEqual([{ key: "TUNNEL_TOKEN", masked: "••••••••" }]);
  });

  it("does not write any file itself — it only returns contents", () => {
    // No filesystem import at all is the real guarantee here; this is a documentation
    // assertion that the returned shape has exactly the two string fields and nothing
    // resembling a path or a write handle.
    const result = scaffoldCloudflared();
    expect(Object.keys(result).sort()).toEqual(["composeFile", "envFile"]);
    expect(typeof result.composeFile).toBe("string");
    expect(typeof result.envFile).toBe("string");
  });

  it("takes no parameters, since it has no user input to sanitise", () => {
    expect(scaffoldCloudflared.length).toBe(0);
  });
});
