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
 * @param {Array<{oid: string, parents: string[]}>} rows topo-ordered rows
 *   (later rows = ancestors).
 * @returns {Array<{columns: string[], merge: boolean}>} per-row lane maps
 *   with glyphs 'node' | 'merge' | 'pass' | 'gap'.
 */
export function assignLanes(rows) {
  const later = new Set();
  for (const row of rows) for (const parent of row.parents) later.add(parent);
  const lanes = [];
  return rows.map((row) => {
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
      else if (typeof pending === 'string' && later.has(pending)) columns.push('pass');
      else columns.push('gap');
    }
    const [first, ...rest] = row.parents.filter((parent) => later.has(parent));
    for (let i = 0; i < lanes.length; i += 1) if (lanes[i] === row.oid && i !== nodeColumn) lanes[i] = null;
    lanes[nodeColumn] = first ?? null;
    for (const parent of rest) if (!lanes.includes(parent)) lanes.push(parent);
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    return { columns, merge: row.parents.length > 1 };
  });
}
