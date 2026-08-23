/**
 * Minimal lane assignment over topo-ordered commit rows (newest first).
 *
 * Each lane waits for one commit; the first parent continues the node's lane,
 * further parents start (or join) lanes to the right. Correct for linear,
 * branched, and merged histories. The columns alone carry the topology.
 *
 * Ported from the upstream dsh git-graph plugin (`assignLanes` in
 * `@linxin666/dsh-client-ui-git-graph`) so behavior matches; the browser
 * bundle keeps an inlined copy (see lib/client.js) — keep both in sync.
 *
 * Cross-page continuation (v0.6.0): pass the previous page's final lane state
 * as `initialLanes` so the next page's lanes continue seamlessly instead of
 * re-starting. A pending lane carried over from the previous page that is NOT
 * consumed by this page (its oid does not appear here) keeps drawing a 'pass'
 * line down to the page boundary; the returned array also carries a `tail`
 * property with the final lane state for the following page.
 *
 * @param {Array<{oid: string, parents: string[]}>} rows topo-ordered rows
 *   (later rows = ancestors).
 * @param {string[]} [initialLanes] pending oid per lane from the previous page.
 * @returns {Array<{columns: string[], merge: boolean}>} per-row lane maps
 *   with glyphs 'node' | 'merge' | 'pass' | 'gap'; `.tail` holds the final
 *   lane state for the next page.
 */
export function assignLanes(rows, initialLanes = []) {
  const later = new Set();
  for (const row of rows) for (const parent of row.parents) later.add(parent);
  const appear = new Set(rows.map((r) => r.oid));
  const carried = initialLanes.length > 0;
  const lanes = [...initialLanes];
  const maps = rows.map((row) => {
    let nodeColumn = lanes.findIndex((pending) => pending === row.oid);
    if (nodeColumn === -1) {
      lanes.push(row.oid);
      nodeColumn = lanes.length - 1;
    }
    const columns = [];
    for (let i = 0; i < lanes.length; i += 1) {
      const pending = lanes[i];
      if (pending === null) columns.push('gap');
      else if (i === nodeColumn) columns.push(row.parents.length > 1 ? 'merge' : 'node');
      else if (pending === row.oid) columns.push('gap');
      // A pending lane that will appear later in this page, or that was
      // carried over from the previous page and is not consumed here, keeps
      // drawing its line (no top-of-page break).
      else if (typeof pending === 'string' && (later.has(pending) || (carried && !appear.has(pending)))) columns.push('pass');
      else columns.push('gap');
    }
    const [first, ...rest] = row.parents.filter((parent) => later.has(parent));
    for (let i = 0; i < lanes.length; i += 1) if (lanes[i] === row.oid && i !== nodeColumn) lanes[i] = null;
    lanes[nodeColumn] = first ?? null;
    for (const parent of rest) if (!lanes.includes(parent)) lanes.push(parent);
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    return { columns, merge: row.parents.length > 1 };
  });
  maps.tail = lanes;
  return maps;
}
