export interface PermissionGrantPollOptions {
  /** Maximum number of read attempts before the final read. Defaults to 8. */
  readonly maxAttempts?: number;
  /** Delay between read attempts, in milliseconds. Defaults to 1000. */
  readonly intervalMs?: number;
  /** Sleeper used between attempts. Injected so tests can avoid real waits. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Await the user's answer to a macOS TCC permission prompt.
 *
 * On macOS, `request_microphone_permission` / `request_camera_permission`
 * (tauri-plugin-macos-permissions) dispatch the system prompt with a null
 * completion handler and resolve as soon as the prompt has been *dispatched*,
 * before the user has clicked Allow/Deny. A single immediate read of the
 * authorization status therefore returns `.notDetermined` (false) while the
 * prompt is still on screen, which a caller branching on the returned boolean
 * mistook for "denied" — opening System Settings and surfacing a "still not
 * granted" error toast while the prompt was still waiting for an answer.
 *
 * Poll the grant status to give the user a bounded window (maxAttempts *
 * intervalMs, 8s by default) to answer the prompt, so the returned boolean
 * reflects the post-prompt state instead of the pre-answer `notDetermined`
 * read. The request is awaited once before the first read so the prompt has
 * been dispatched before we start polling.
 */
export async function waitForPermissionGrant(
  request: () => Promise<void>,
  read: () => Promise<boolean>,
  options?: PermissionGrantPollOptions,
): Promise<boolean> {
  const maxAttempts = options?.maxAttempts ?? 8;
  const intervalMs = options?.intervalMs ?? 1000;
  const sleep =
    options?.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));

  // Awaited first: this is the fire-and-forget prompt dispatch. It resolves
  // as soon as the prompt is shown, not when the user answers.
  await request();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await read()) return true;
    await sleep(intervalMs);
  }
  return read();
}
