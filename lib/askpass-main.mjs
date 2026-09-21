#!/usr/bin/env node
/**
 * Git askpass bridge — helper half (`GIT_ASKPASS`).
 *
 * Why this exists (2026-09-22, Linux freeze incident):
 *   Without an askpass program, git asks for credentials **on the terminal**.
 *   On Linux that means `open("/dev/tty")` + blocking read — *not* stderr/stdin,
 *   so the host half can neither see the prompt nor answer it. When dsh web
 *   inherits a controlling terminal, git's prompt is written into that console
 *   and git blocks on it; the operation never returns and the console wedges.
 *   (`gitcredentials(7)`: GIT_ASKPASS → core.askPass → SSH_ASKPASS → terminal.)
 *
 * This program is invoked by git as `askpass <prompt>`; git reads the answer
 * from its **stdout**. The answer comes from the browser dialog: we POST the
 * prompt to the plugin's own HTTP endpoint and block until the user answers.
 *
 * Design notes (mirrors VS Code's `askpass-main.ts`):
 *  - the transport is an out-of-band channel (there: an IPC pipe; here: the
 *    plugin's loopback HTTP endpoint), because git gives the helper no usable
 *    stdin (verified: the helper's stdin is NOT git's stdin pipe);
 *  - stdout carries **only** the credential — anything else would be consumed
 *    by git as part of the answer, so diagnostics go to stderr;
 *  - any failure exits non-zero and prints nothing, so git fails fast with its
 *    own authentication error instead of waiting forever.
 *
 * Environment (all set by lib/routes.js when spawning the network op):
 *   DSH_GIT_ASKPASS_ENDPOINT  plugin API URL (loopback)
 *   DSH_GIT_ASKPASS_TOKEN     per-operation secret
 *   DSH_GIT_ASKPASS_OPID      operation id (ties prompts to one push/pull)
 *   DSH_GIT_ASKPASS_SESSION   dsh session id (the API requires it)
 *   DSH_GIT_ASKPASS_TIMEOUT_MS  optional, must stay below the host wait
 */

/** Hard client-side cap: a bit above the host's prompt wait so the host's
 *  own timeout produces the user-visible outcome. */
const DEFAULT_TIMEOUT_MS = 185_000;

/** Print a diagnostic to stderr (never stdout) and exit non-zero. */
function fail(message) {
  try {
    process.stderr.write(`[dsh-git-askpass] ${message}\n`);
  } catch {
    /* ignore */
  }
  process.exit(1);
}

/** Extract protocol/host context from git's prompt, for logging only. */
function describePrompt(prompt) {
  const m = /for\s+'([^']+)'/.exec(prompt);
  return m ? m[1] : prompt;
}

async function main() {
  // git passes the prompt as one argument; the launcher keeps it quoted, so
  // argv[2] is the whole text (VS Code lets the shell word-split it, which is
  // fragile — see vscode#230033 about interleaved username/password requests).
  const prompt = String(process.argv[2] ?? '');
  const endpoint = String(process.env.DSH_GIT_ASKPASS_ENDPOINT ?? '').trim();
  const token = String(process.env.DSH_GIT_ASKPASS_TOKEN ?? '').trim();
  const opId = String(process.env.DSH_GIT_ASKPASS_OPID ?? '').trim();
  const sessionId = String(process.env.DSH_GIT_ASKPASS_SESSION ?? '').trim();

  if (endpoint === '' || token === '' || opId === '' || sessionId === '') {
    fail('missing bridge environment (endpoint/token/opId/session)');
  }

  const timeoutMs = Number(process.env.DSH_GIT_ASKPASS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let payload;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, method: 'askpass-wait', opId, token, prompt }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) fail(`bridge HTTP ${res.status}`);
    payload = await res.json();
  } catch (error) {
    clearTimeout(timer);
    fail(`bridge unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!payload || payload.ok !== true) {
    fail(payload?.error?.message ?? 'bridge rejected the prompt');
  }

  // Empty answer = user cancelled: print an empty line so git reports an
  // authentication failure rather than retrying.
  const value = payload.value?.value ?? '';
  process.stdout.write(String(value) + '\n');
  process.exit(0);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
