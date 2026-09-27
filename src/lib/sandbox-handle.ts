import { Computer, type MacOSSandbox } from "use-computer-sdk";
import { requireEnv } from "./env";
import { dismissScreenRecordingPrompt } from "./sandbox";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * The subset of MacOSSandbox's public API this app actually calls (see src/lib/sandbox.ts).
 * A real `MacOSSandbox` returned by `Computer.create()` already structurally satisfies this —
 * no adapter needed there. `attachSandbox()` below builds a second, independent implementation
 * of the same interface that needs nothing but a sandbox id.
 */
export interface SandboxHandle {
  readonly sandboxId: string;
  readonly vncUrl: string;
  readonly host: string;
  uiTree(): Promise<unknown>;
  /**
   * `use-computer-sdk`'s own .d.ts declares this shape (`{width,height}`), which is why it's
   * declared this way here too (so a real `MacOSSandbox` keeps structurally satisfying this
   * interface). Caution: verified against a real sandbox, the SDK's own `MacOSSandbox` instance
   * does NOT actually return this shape at runtime -- it returns the gateway's raw
   * `{ success, size: { width, height } }` unmodified, which does not match its own declared
   * type. `attachSandbox()` below normalizes to the declared `{width,height}` shape, but any
   * caller going through a real SDK-created sandbox must defensively check for a nested `size`
   * too (see `setDisplayResolution` in sandbox.ts).
   */
  displayInfo(): Promise<{ width: number; height: number }>;
  /** Screen recording, native to the gateway (matches `use-computer-sdk`'s `MacOSSandbox.recording`
   * surface: `start()/stop()/listAll()/download()`). Only `start`/`stop` are declared here --
   * `downloadRecording()` in sandbox.ts bypasses the SDK's own `recording.download()` the same way
   * `takeScreenshot()` bypasses `screenshot.takeCompressed()`, to capture the response's
   * content-type (which the SDK's `getBytes()` helper discards). */
  recording: {
    start(): Promise<string>;
    stop(recordingId: string): Promise<{ recordingId: string; fileSize?: number }>;
  };
  execSsh(command: string, timeoutMs?: number): Promise<ExecResult>;
  upload(data: Uint8Array, remotePath: string): Promise<void>;
  mouse: { click(x: number, y: number): Promise<void> };
  keyboard: {
    type(text: string): Promise<void>;
    press(key: string): Promise<void>;
    hotkey(combo: string): Promise<void>;
  };
  close(): Promise<void>;
}

/** What travels between client and server to keep acting on "the same" sandbox. */
export interface SandboxDescriptor {
  sandboxId: string;
  host: string;
  vncUrl: string;
}

/** The SDK reports a reaped or deleted sandbox as an Error whose message starts with the HTTP status. */
export function isGone(err: unknown): boolean {
  return err instanceof Error && /^(404|410) /.test(err.message);
}

const DEFAULT_BASE_URL = "https://api.use.computer";

function baseUrl(): string {
  return process.env.USE_COMPUTER_BASE_URL || DEFAULT_BASE_URL;
}

/**
 * Create a brand-new sandbox on the already-reserved Mac (a real network call) and dismiss its
 * screen-recording prompt so it's immediately drivable. Reads USE_COMPUTER_API_KEY and
 * USE_COMPUTER_RESERVATION_ID; never reserves.
 */
export async function createSandbox(): Promise<SandboxHandle> {
  const apiKey = requireEnv("USE_COMPUTER_API_KEY");
  const reservationId = requireEnv("USE_COMPUTER_RESERVATION_ID");
  const computer = new Computer({ apiKey });
  const sandbox: MacOSSandbox = await computer.create({ type: "macos", reservationId });
  await dismissScreenRecordingPrompt(sandbox);
  return sandbox;
}

/**
 * Rebuild a handle for an *existing* sandbox from nothing but its id — zero network calls.
 * `use-computer-sdk`'s own `MacOSSandbox` methods only ever address `${baseUrl}/v1/sandboxes/{id}/...`
 * with a Bearer-token header; none of them read `sshUrl`/`vmIp`/`host` (verified against the SDK's
 * compiled source), so those fields are purely cosmetic here. `host`/`vncUrl` are carried through
 * as given (never re-fetched — there is no "look up a sandbox's vncUrl by id" endpoint to call).
 * The first real operation against the returned handle will throw a `404 `/`410 ` error (caught by
 * `isGone`) if the sandbox has actually been reaped, exactly like a fresh SDK object would.
 *
 * This function duplicates a slice of `use-computer-sdk`'s wire protocol by hand (endpoint paths,
 * request/response shapes) below, because the SDK itself exposes no "reconnect by id" method.
 * `use-computer-sdk` is pinned to an exact version in package.json (not a `^` range) specifically
 * so a dependency bump is a deliberate, reviewed step: re-diff the endpoints below against the new
 * version's `dist/sandbox.js`/`dist/http.js` before bumping, since nothing else will catch this
 * function silently drifting out of sync with a changed gateway wire format.
 */
export function attachSandbox(descriptor: SandboxDescriptor): SandboxHandle {
  const apiKey = requireEnv("USE_COMPUTER_API_KEY");
  const url = `${baseUrl().replace(/\/+$/, "")}/v1/sandboxes/${descriptor.sandboxId}`;

  async function call<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    const { timeoutMs, ...rest } = init ?? {};
    const res = await fetch(`${url}${path}`, {
      ...rest,
      headers: { Authorization: `Bearer ${apiKey}`, ...(rest.headers ?? {}) },
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${url}${path}: ${body.slice(0, 500)}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    return ct.startsWith("application/json") ? ((await res.json()) as T) : (undefined as T);
  }

  const postJSON = <T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> =>
    call<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}), timeoutMs });

  return {
    sandboxId: descriptor.sandboxId,
    vncUrl: descriptor.vncUrl,
    host: descriptor.host,
    uiTree: () => call("/display/windows"),
    async displayInfo() {
      // Normalize the gateway's raw `{ success, size: { width, height } }` to the declared
      // `{width,height}` shape -- see the interface's doc comment for why this differs from what
      // a real SDK-created MacOSSandbox actually returns at runtime.
      const d = await call<{ size?: { width: number; height: number }; width?: number; height?: number }>("/display/info");
      return { width: d.size?.width ?? d.width ?? 0, height: d.size?.height ?? d.height ?? 0 };
    },
    async execSsh(command, timeoutMs = 120_000) {
      const d = await postJSON<{ stdout?: string; stderr?: string; exit_code?: number; return_code?: number; returncode?: number }>(
        "/exec",
        { command },
        timeoutMs,
      );
      return {
        stdout: String(d.stdout ?? ""),
        stderr: String(d.stderr ?? ""),
        exitCode: Number(d.exit_code ?? d.return_code ?? d.returncode ?? 0),
      };
    },
    async upload(data, remotePath) {
      // Cast needed because TS's ArrayBufferView/BodyInit generics don't line up cleanly with a
      // plain `Uint8Array` parameter type across TS/DOM-lib versions; the bytes are what fetch cares
      // about at runtime, not the generic tag.
      await call(`/files?path=${encodeURIComponent(remotePath)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: data as BodyInit,
      });
    },
    recording: {
      async start() {
        const d = await postJSON<{ recording_id?: string; id?: string }>("/recording/start");
        return String(d.recording_id ?? d.id ?? "");
      },
      async stop(recordingId) {
        const d = await postJSON<{ recording_id?: string; file_size?: number }>("/recording/stop", { recording_id: recordingId });
        return { recordingId: String(d.recording_id ?? recordingId), fileSize: Number(d.file_size ?? 0) };
      },
    },
    mouse: {
      click: (x, y) => postJSON("/mouse/click", { x, y, button: "left" }),
    },
    keyboard: {
      type: (text) => postJSON("/keyboard/type", { text }),
      press: (key) => postJSON("/keyboard/press", { key }),
      hotkey: (combo) => postJSON("/keyboard/hotkey", { keys: combo }),
    },
    close: () => call("", { method: "DELETE" }),
  };
}

/**
 * `descriptor` absent -> `createSandbox()` (real call). `descriptor` present -> `attachSandbox()`
 * (no call, optimistic — the caller finds out it's stale only if/when it actually uses the handle).
 */
export async function resolveSandbox(
  descriptor?: SandboxDescriptor,
): Promise<{ handle: SandboxHandle; descriptor: SandboxDescriptor }> {
  const handle = descriptor ? attachSandbox(descriptor) : await createSandbox();
  return { handle, descriptor: toDescriptor(handle) };
}

export function toDescriptor(handle: SandboxHandle): SandboxDescriptor {
  return { sandboxId: handle.sandboxId, host: handle.host, vncUrl: handle.vncUrl };
}

/**
 * A box a caller holds across many operations in one request (e.g. one agent turn's up to
 * MAX_AGENT_STEPS tool calls), so a mid-turn recreate is visible to every subsequent call without
 * re-threading a handle through each tool's return value.
 */
export interface SandboxRef {
  current: SandboxHandle;
}

/**
 * Run `fn` against `ref.current`. If it fails with a "gone" error (the sandbox timed out or was
 * otherwise deleted), create a fresh sandbox, swap it into `ref.current`, and retry `fn` exactly
 * once against the new handle. Callers that need to tell a client the sandbox changed just read
 * `ref.current` after this resolves (e.g. `toDescriptor(ref.current)`) -- there's no separate
 * rotation-notification callback to wire up, since `ref.current` is always the single source of
 * truth for "which sandbox did this actually end up using." `create` is injectable so this is
 * unit-testable without a real network call.
 */
export async function withSandbox<T>(
  ref: SandboxRef,
  fn: (handle: SandboxHandle) => Promise<T>,
  opts?: { create?: () => Promise<SandboxHandle> },
): Promise<T> {
  try {
    return await fn(ref.current);
  } catch (err) {
    if (!isGone(err)) throw err;
    ref.current = await (opts?.create ?? createSandbox)();
    return fn(ref.current);
  }
}
