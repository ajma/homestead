import type {
  IdpOption,
  TunnelRuntime,
  ZoneOption,
} from "@shared/cloudflare.js";
import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { Button, EmptyState, Input, Spinner } from "../components/ui/index.js";
import { ApiError } from "../lib/api.js";
import {
  type AccountOption,
  useCloudflareStatus,
  useSelectAccount,
  useSetupTunnel,
  useVerifyToken,
} from "../lib/queries.js";

type Step = "token" | "account" | "identity-provider" | "runtime" | "done";

type SetupState = {
  step: Step;
  accounts: AccountOption[];
  selectedAccountId: string | null;
  zones: ZoneOption[];
  idps: IdpOption[];
  selectedIdpId: string | null;
  runtime: TunnelRuntime | null;
  tunnelId: string | null;
};

export function CloudflareSetup() {
  const { data: status, isPending: statusPending } = useCloudflareStatus();
  const [state, setState] = useState<SetupState>({
    step: "token",
    accounts: [],
    selectedAccountId: null,
    zones: [],
    idps: [],
    selectedIdpId: null,
    runtime: null,
    tunnelId: null,
  });

  // Resume from existing state if configured
  useEffect(() => {
    if (
      status?.configured &&
      status.accountId &&
      status.idpId &&
      status.runtime
    ) {
      setState({
        step: "done",
        accounts: [],
        selectedAccountId: status.accountId,
        zones: [],
        idps: [],
        selectedIdpId: status.idpId,
        runtime: status.runtime as TunnelRuntime,
        tunnelId: status.tunnelId,
      });
    }
  }, [status]);

  if (statusPending) {
    return (
      <main className="mx-auto w-full max-w-2xl p-4 sm:p-8">
        <div className="flex justify-center py-12 text-muted">
          <Spinner />
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-2xl p-4 sm:p-8">
      <h1 className="text-2xl font-semibold text-text mb-6">
        Configure Cloudflare Tunnel
      </h1>
      <p className="text-sm text-muted mb-6">
        Set up Cloudflare Tunnel to publish services securely at a public
        hostname with authentication.
      </p>

      {state.step === "token" && (
        <TokenStep state={state} setState={setState} />
      )}
      {state.step === "account" && (
        <AccountStep state={state} setState={setState} />
      )}
      {state.step === "identity-provider" && (
        <IdentityProviderStep state={state} setState={setState} />
      )}
      {state.step === "runtime" && (
        <RuntimeStep state={state} setState={setState} />
      )}
      {state.step === "done" && <DoneStep state={state} />}
    </main>
  );
}

function TokenStep({
  state,
  setState,
}: {
  state: SetupState;
  setState: (state: SetupState) => void;
}) {
  // The token is deliberately held here rather than in the wizard's shared
  // state: this step unmounts on transition, so React discards it and the
  // credential cannot outlive the request. Lifting it to the parent would keep
  // it in memory for the rest of the session — a change in security posture,
  // not a refactor. The "navigating back shows an empty field" test is what
  // would catch that.
  const [token, setToken] = useState("");
  const verify = useVerifyToken();
  const tokenId = useId();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const result = await verify.mutateAsync(token);
      // Clear token from state immediately after successful submission
      setToken("");
      setState({
        ...state,
        step: "account",
        accounts: result.accounts,
      });
    } catch {
      // Error is handled by verify.error
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor={tokenId} className="block text-sm font-medium mb-1">
          API Token
        </label>
        <Input
          id={tokenId}
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Enter your Cloudflare API token"
          required
          autoComplete="off"
        />
        <div className="mt-2 text-xs text-muted">
          <p>
            Create one at{" "}
            <a
              href="https://dash.cloudflare.com/profile/api-tokens"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline"
            >
              My Profile → API Tokens
            </a>
            . Choose <strong>Create Token</strong>, then{" "}
            <strong>Create Custom Token</strong> — it is the “Get started”
            button below the templates, not one of the templates — and add these
            six permissions:
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li>Account · Cloudflare Tunnel · Edit</li>
            <li>Account · Access: Apps and Policies · Edit</li>
            <li>Account · Access: Service Tokens · Edit</li>
            <li>Zone · Zone · Read</li>
            <li>Zone · DNS · Edit</li>
            <li>
              User · Memberships · Read{" "}
              <span className="text-muted">
                — under <strong>User</strong>, not Account or Zone. Without it
                Homestead cannot list your accounts.
              </span>
            </li>
          </ul>
          <p className="mt-1">
            Set Account Resources to the account you are configuring, and Zone
            Resources to the zones you will expose. It must be a user token: an
            account-owned token cannot grant the Memberships permission.
          </p>
        </div>
      </div>

      {verify.error && (
        <div role="alert" className="text-sm text-danger">
          {verify.error instanceof ApiError && verify.error.detail
            ? verify.error.detail
            : "Failed to verify token"}
        </div>
      )}

      <div className="flex justify-end">
        <Button type="submit" disabled={verify.isPending || !token}>
          {verify.isPending ? "Verifying..." : "Continue"}
        </Button>
      </div>
    </form>
  );
}

function AccountStep({
  state,
  setState,
}: {
  state: SetupState;
  setState: (state: SetupState) => void;
}) {
  const selectAccount = useSelectAccount();
  const [selected, setSelected] = useState<string | null>(null);

  async function handleContinue() {
    if (!selected) return;
    try {
      const result = await selectAccount.mutateAsync(selected);
      setState({
        ...state,
        step: "identity-provider",
        selectedAccountId: selected,
        zones: result.zones,
        idps: result.idps,
      });
    } catch (err) {
      // If the error is about no identity provider, transition to the identity-provider
      // step with an empty idps array, which will show the blocking state
      if (
        err instanceof ApiError &&
        err.status === 400 &&
        err.detail?.toLowerCase().includes("identity provider")
      ) {
        setState({
          ...state,
          step: "identity-provider",
          selectedAccountId: selected,
          zones: [],
          idps: [],
        });
      }
      // Other errors are shown via selectAccount.error
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="block text-sm font-medium mb-2">Select Account</div>
        <ul className="space-y-2">
          {state.accounts.map((account) => (
            <li key={account.id}>
              <button
                type="button"
                onClick={() => setSelected(account.id)}
                className={`w-full text-left px-4 py-3 rounded-lg border border-border min-h-11 ${
                  selected === account.id
                    ? "bg-accent/10 border-accent"
                    : "bg-surface hover:bg-raised"
                }`}
              >
                {account.name}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {selectAccount.error && (
        <div role="alert" className="text-sm text-danger">
          {selectAccount.error instanceof ApiError && selectAccount.error.detail
            ? selectAccount.error.detail
            : "Failed to fetch account details"}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => setState({ ...state, step: "token" })}
        >
          Back
        </Button>
        <Button
          onClick={handleContinue}
          disabled={selectAccount.isPending || !selected}
        >
          {selectAccount.isPending ? "Loading..." : "Continue"}
        </Button>
      </div>
    </div>
  );
}

function IdentityProviderStep({
  state,
  setState,
}: {
  state: SetupState;
  setState: (state: SetupState) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  // If no IdPs, show blocking state
  if (state.idps.length === 0) {
    return (
      <EmptyState
        title="No identity provider configured"
        description="This account has no identity provider configured. Cloudflare Access requires an identity provider to authenticate users. Configure one in the Cloudflare dashboard first."
        action={
          <a
            href="https://dash.cloudflare.com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block"
          >
            <Button>Open Cloudflare Dashboard</Button>
          </a>
        }
      />
    );
  }

  function handleContinue() {
    if (!selected) return;
    setState({
      ...state,
      step: "runtime",
      selectedIdpId: selected,
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="block text-sm font-medium mb-2">
          Select Identity Provider
        </div>
        <ul className="space-y-2">
          {state.idps.map((idp) => (
            <li key={idp.id}>
              <button
                type="button"
                onClick={() => setSelected(idp.id)}
                className={`w-full text-left px-4 py-3 rounded-lg border border-border min-h-11 ${
                  selected === idp.id
                    ? "bg-accent/10 border-accent"
                    : "bg-surface hover:bg-raised"
                }`}
              >
                <div className="font-medium">{idp.name}</div>
                <div className="text-xs text-muted">{idp.type}</div>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex justify-end">
        <Button onClick={handleContinue} disabled={!selected}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function RuntimeStep({
  state,
  setState,
}: {
  state: SetupState;
  setState: (state: SetupState) => void;
}) {
  const setup = useSetupTunnel();

  async function handleSetup() {
    if (!state.selectedIdpId) return;
    try {
      const result = await setup.mutateAsync(state.selectedIdpId);
      setState({
        ...state,
        step: "done",
        runtime: result.runtime,
        tunnelId: result.tunnelId,
      });
    } catch {
      // Error is handled by setup.error
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-lg font-semibold mb-2">Ready to create tunnel</h2>
        <p className="text-sm text-muted">
          Homestead will create a Cloudflare Tunnel, configure Access policies,
          and deploy the tunnel runtime.
        </p>
      </div>

      {setup.error && (
        <div role="alert" className="text-sm text-danger">
          {setup.error instanceof ApiError && setup.error.detail
            ? setup.error.detail
            : "Failed to create tunnel"}
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={handleSetup} disabled={setup.isPending}>
          {setup.isPending ? "Creating tunnel..." : "Create Tunnel"}
        </Button>
      </div>
    </div>
  );
}

function DoneStep({ state }: { state: SetupState }) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-lg font-semibold mb-2">Setup complete</h2>
        <p className="text-sm text-muted mb-4">
          Your Cloudflare Tunnel is configured and ready to use. You can now add
          exposures to publish services.
        </p>
        {state.runtime?.kind === "deployed" && (
          <p className="text-xs text-muted">
            Runtime deployed to project: {state.runtime.projectSlug}
          </p>
        )}
        {state.runtime?.kind === "adopted" && (
          <p className="text-xs text-muted">
            Using existing container: {state.runtime.containerId.slice(0, 12)}
          </p>
        )}
      </div>

      <div className="flex justify-end">
        <Link to="/exposures">
          <Button>Go to Exposures</Button>
        </Link>
      </div>
    </div>
  );
}
