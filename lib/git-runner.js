/**
 * Git execution for the host half: one managed `git` child per command with
 * a hard timeout and a collected-output cap. Pure spawn (no shell), so
 * branch/rev names can never be interpreted by a shell.
 *
 * Credential interaction (v0.6.0+): when git needs a username/password /
 * passphrase it writes a prompt to stderr and waits for input on stdin
 * (git does this even without a tty when GIT_TERMINAL_PROMPT is on).
 * If `onPrompt` is provided, the pending prompt line is forwarded to it and
 * the returned answer is written back to the child's stdin; otherwise the
 * prompt is left unanswered (git fails fast with its own message).
 */
import { spawn } from 'node:child_process';

/** Collected-output cap for one git command (stdout+stderr each). */
export const OUTPUT_CAP_BYTES = 1 << 20; // 1 MiB
/** Default per-command timeout. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** How long a credential prompt may wait for an answer before the git child is killed. */
export const PROMPT_TIMEOUT_MS = 120_000;
/** Exit code convention for "could not even spawn git". */
export const SPAWN_FAILURE_EXIT = 127;

/** A stderr line that looks like a git credential prompt (ends with ': ' and
 *  names a username/password/passphrase). Trailing whitespace stripped. */
function promptTextOf(line) {
  const m = /^(.+?(?:Username for|Password for|passphrase for|credentials?).*?:\s*)$/i.exec(line);
  return m ? m[1].replace(/\s+$/, '') : null;
}

/**
 * Run one git command.
 * @param {string} cwd repository working directory.
 * @param {string[]} args git arguments (without the leading 'git').
 * @param {{timeoutMs?: number, maxBytes?: number, env?: Record<string,string>, signal?: AbortSignal, onPrompt?: (prompt: string) => Promise<string>}} [options]
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
export function runGit(cwd, args, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = OUTPUT_CAP_BYTES,
    env,
    signal,
    onPrompt,
  } = options;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        env: env ?? process.env,
        windowsHide: true,
        // stdin is a pipe so credential answers can be written back.
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        exitCode: SPAWN_FAILURE_EXIT,
        stdout: '',
        stderr: `git: spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let prompting = false;
    let promptTimer = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(promptTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const collect = (chunk, side) => {
      const target = side === 'out' ? 'stdout' : 'stderr';
      if (target === 'stdout') {
        if (stdout.length < maxBytes) stdout += String(chunk);
      } else if (stderr.length < maxBytes) stderr += String(chunk);
    };
    child.stdout.on('data', (d) => collect(d, 'out'));
    // stderr carries credential prompts; watch for an unanswered prompt line
    // and forward it to onPrompt when available.
    child.stderr.on('data', (d) => {
      collect(d, 'err');
      if (!onPrompt || prompting || settled) return;
      const tail = stderr.slice(-4096);
      const prompt = promptTextOf(tail);
      if (prompt === null) return;
      prompting = true;
      let answered = false;
      const answer = (value) => {
        if (answered) return;
        answered = true;
        clearTimeout(promptTimer);
        try { child.stdin.write(String(value ?? '') + '\n'); } catch { /* ignore */ }
        prompting = false;
      };
      promptTimer = setTimeout(() => {
        // No answer in time: close stdin so git fails fast instead of hanging.
        answer('');
        try { child.stdin.end(); } catch { /* ignore */ }
      }, PROMPT_TIMEOUT_MS);
      Promise.resolve()
        .then(() => onPrompt(prompt))
        .then((v) => answer(v))
        .catch(() => {
          // Answer rejected (e.g. prompt aborted): close stdin so git fails.
          answer('');
          try { child.stdin.end(); } catch { /* ignore */ }
        });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    };
    if (signal) {
      if (signal.aborted) { onAbort(); }
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (error) => {
      finish({
        exitCode: SPAWN_FAILURE_EXIT,
        stdout,
        stderr: `git: spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
    child.on('close', (exitCode) => {
      if (timedOut) {
        finish({ exitCode: 124, stdout, stderr: (stderr + '\ngit: timed out after ' + timeoutMs + 'ms').trim() });
        return;
      }
      finish({ exitCode: exitCode ?? SPAWN_FAILURE_EXIT, stdout, stderr });
    });
  });
}
