/**
 * Git execution for the host half: one managed `git` child per command with
 * a hard timeout and a collected-output cap. Pure spawn (no shell), so
 * branch/rev names can never be interpreted by a shell.
 */
import { spawn } from 'node:child_process';

/** Collected-output cap for one git command (stdout+stderr each). */
export const OUTPUT_CAP_BYTES = 1 << 20; // 1 MiB
/** Default per-command timeout. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Exit code convention for "could not even spawn git". */
export const SPAWN_FAILURE_EXIT = 127;

/**
 * Run one git command.
 * @param {string} cwd repository working directory.
 * @param {string[]} args git arguments (without the leading 'git').
 * @param {{timeoutMs?: number, maxBytes?: number, env?: Record<string,string>, signal?: AbortSignal}} [options]
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
export function runGit(cwd, args, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = OUTPUT_CAP_BYTES,
    env,
    signal,
  } = options;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        env: env ?? process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
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
    const collect = (chunk, side) => {
      const target = side === 'out' ? 'stdout' : 'stderr';
      if (target === 'stdout') {
        if (stdout.length < maxBytes) stdout += String(chunk);
      } else if (stderr.length < maxBytes) stderr += String(chunk);
    };
    child.stdout.on('data', (d) => collect(d, 'out'));
    child.stderr.on('data', (d) => collect(d, 'err'));
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
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        exitCode: SPAWN_FAILURE_EXIT,
        stdout,
        stderr: `git: spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (timedOut) {
        resolve({ exitCode: 124, stdout, stderr: (stderr + '\ngit: timed out after ' + timeoutMs + 'ms').trim() });
        return;
      }
      resolve({ exitCode: exitCode ?? SPAWN_FAILURE_EXIT, stdout, stderr });
    });
  });
}
