/**
 * dsh-shinki-git-graph host half: mounts the read-only git service routes
 * (`/shinki-git/api`) once the web profile activates. The browser half
 * (lib/client.js) registers the sidebar tab and renders the graph.
 */
import { createHandler } from './routes.js';

export const name = 'dsh-shinki-git-graph';

/**
 * Services required before mounting (cordis inject): property access without
 * an inject declaration is rejected at runtime ("cannot get property without
 * inject"). Mirrors dsh-better-sidebar's host-side declaration.
 */
export const inject = ['webServer', 'sessions', 'webRuntime'];

/**
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'prefix',
        path: '/shinki-git',
        handler: createHandler(ctx),
      }),
    ];
    return () => { for (const d of disposers) d(); };
  }, 'dsh-shinki-git-graph: http routes');
}
