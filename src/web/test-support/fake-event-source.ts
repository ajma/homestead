/**
 * A stand-in for the browser's `EventSource`.
 *
 * jsdom does not implement `EventSource` at all, so there is nothing to spy
 * on and nothing to intercept — which is why {@link useEventStream} reads the
 * constructor off `globalThis` when it opens rather than closing over the
 * import. A test puts this there instead.
 *
 * The behaviour worth simulating is the one a real connection will not produce
 * on demand: a drop mid-operation, followed by a reconnect that replays the
 * server's whole buffer — or replays nothing at all, because the operation
 * finished and aged out of the registry between the two connections.
 */
export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  /** Every instance constructed since the last {@link reset}, in order. */
  static readonly instances: FakeEventSource[] = [];

  static get last(): FakeEventSource | undefined {
    return FakeEventSource.instances.at(-1);
  }

  static reset(): void {
    FakeEventSource.instances.length = 0;
  }

  readonly url: string;
  readyState: number = FakeEventSource.CONNECTING;
  /** Counted rather than flagged: closing twice is a bug worth seeing. */
  closeCount = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closeCount++;
    this.readyState = FakeEventSource.CLOSED;
  }

  /** The browser's `open` — including the one that follows a reconnect. */
  emitOpen(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event("open"));
  }

  /** One `data:` frame, JSON-encoded the way the server encodes it. */
  emitMessage(payload: unknown): void {
    this.emitRaw(JSON.stringify(payload));
  }

  /** A frame whose body is whatever the caller says, valid JSON or not. */
  emitRaw(data: string): void {
    this.onmessage?.(new MessageEvent<string>("message", { data }));
  }

  emitError(): void {
    this.onerror?.(new Event("error"));
  }
}
