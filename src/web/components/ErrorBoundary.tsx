import { Component, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  /**
   * Called once, right before this boundary clears its own error state and re-renders
   * `children`. For a failed lazy chunk this is the caller's chance to hand back a FRESH
   * subtree rather than the one that just threw — see `LazyRoute` in `App.tsx`, which
   * uses it to mint a new `React.lazy` component so the retry actually re-issues the
   * dynamic `import()` instead of replaying the same cached rejection (see the note on
   * that below). Optional because not every boundary needs to reset anything else.
   */
  onRetry?: () => void;
};

type State = { error: unknown };

/**
 * Catches a throw from the subtree it wraps and keeps everything OUTSIDE that subtree
 * mounted — the nav, the other tabs, the rest of the admin shell all stay interactive.
 *
 * Added because there was no error boundary anywhere in this app (confirmed by grep) when
 * `App.tsx` put `ComposeTab` and `EnvTab` behind `React.lazy`. A chunk that fails to
 * load — a deploy landing mid-session, the NAS dropping off the network right as an admin
 * opens a tab — throws uncaught inside `Suspense`, and with nothing above it to catch
 * that, React unmounts the entire root. Not the route: the whole admin UI goes blank,
 * with no way back but a full page reload. That is a worse failure mode for this product
 * than for most — the spec's whole premise is that Homestead keeps working when the
 * infrastructure around it does not.
 *
 * `React.lazy` memoizes its loader's promise on the lazy object itself, forever, once it
 * settles — clearing this boundary's own error and re-rendering the exact same `<Comp />`
 * element would just replay the same rejected promise and re-throw synchronously. Real
 * retry needs a NEW lazy component, which only the caller (the one holding the loader
 * function) can make; `onRetry` is this boundary's hook for asking for one, called before
 * `children` renders again.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  private retry = () => {
    this.props.onRetry?.();
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className="rounded-2xl border border-rose-300 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300"
        >
          <p className="font-medium">This part of the page failed to load.</p>
          <p className="mt-1">
            This can happen if Homestead was redeployed, or the connection dropped, while this was
            open. The rest of this page is unaffected.
          </p>
          <button
            type="button"
            onClick={this.retry}
            className="mt-3 rounded-lg border border-rose-400 px-2 py-1 text-xs font-medium dark:border-rose-700"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
