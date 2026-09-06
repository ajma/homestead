/**
 * The one HTTP error the app throws. `code` is the server's machine-readable
 * `{ error }` string — "operation_in_progress", "forbidden" — which callers
 * branch on; `status` is what decides retry and redirect policy.
 *
 * `detail` is the server's human-readable half of the same body. It is the
 * only thing that says *which* operation is already running behind a 409, so
 * dropping it left the user with "an operation is already running" and no way
 * to know what.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly detail?: string;

  constructor(status: number, code?: string, detail?: string) {
    super(code ? `${status} ${code}` : `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * A 204, an empty body or a non-JSON error page all mean "there is nothing to
 * parse" — not "the request failed". Returning null keeps that distinction.
 */
async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stringField(body: unknown, field: "error" | "detail") {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * Every call to the Homestead API goes through here.
 *
 * The `T | null` return is deliberate: a 204 has no JSON, and typing that away
 * as `T` would be a lie the compiler then helps you believe. Callers that know
 * a body is guaranteed narrow it at the call site.
 */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  const headers = new Headers(init?.headers);
  // Only when we are actually sending something: a Content-Type on a GET
  // describes a body that does not exist.
  if (
    init?.body !== undefined &&
    init.body !== null &&
    !headers.has("content-type")
  )
    headers.set("Content-Type", "application/json");

  const response = await fetch(path, {
    ...init,
    headers,
    // Better-Auth's session lives in a cookie; without this a cross-origin
    // dev proxy would drop it and every call would 401.
    credentials: "same-origin",
  });

  if (!response.ok) {
    const body = await readJson(response);
    // Handled once, here, rather than in every caller. A 403 is deliberately
    // not included: the user is signed in, they simply lack the permission,
    // and bouncing them to /login would loop.
    if (response.status === 401) window.location.assign("/login");
    throw new ApiError(
      response.status,
      stringField(body, "error"),
      stringField(body, "detail"),
    );
  }

  return (await readJson(response)) as T | null;
}
