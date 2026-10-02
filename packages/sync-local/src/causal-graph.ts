/** Edges point from a revision to its prerequisites. No clock participates. */
export interface CausalNode { objectId: string; parents: string[]; dependencies: { objectId: string; revisionId: string }[] }

/** Kahn ordering with a min heap: IDs break ties only among available nodes. */
export function causalOrder(graph: ReadonlyMap<string, CausalNode>, relation: 'parents' | 'dependencies' | 'combined' = 'combined'): string[] {
  const degree = new Map<string, number>(), successors = new Map<string, string[]>(), heap: string[] = [];
  const push = (id: string) => {
    let i = heap.length; heap.push(id);
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p] <= id) break; heap[i] = heap[p]; i = p; }
    heap[i] = id;
  };
  const pop = () => {
    const first = heap[0], last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let c = i * 2 + 1; if (c + 1 < heap.length && heap[c + 1] < heap[c]) c++;
        if (heap[c] >= last) break; heap[i] = heap[c]; i = c;
      }
      heap[i] = last;
    }
    return first;
  };
  for (const [id, node] of graph) {
    const edges = new Set([...(relation === 'dependencies' ? [] : node.parents),
      ...(relation === 'parents' ? [] : node.dependencies.map(d => d.revisionId))]);
    degree.set(id, edges.size);
    for (const edge of edges) {
      if (!graph.has(edge)) throw new Error('missing_causal_revision');
      const list = successors.get(edge) ?? []; list.push(id); successors.set(edge, list);
    }
    if (!edges.size) push(id);
  }
  const ordered: string[] = [];
  while (heap.length) {
    const id = pop(); ordered.push(id);
    for (const next of successors.get(id) ?? []) {
      const n = degree.get(next)! - 1; degree.set(next, n); if (!n) push(next);
    }
  }
  if (ordered.length !== graph.size) throw new Error(`causal_${relation}_cycle`);
  return ordered;
}

/** Unique maximal common ancestor under parent edges only. Linear per head. */
export function causalCommonBase(graph: ReadonlyMap<string, Pick<CausalNode, 'parents'>>, heads: string[]): string | null {
  if (!heads.length) return null;
  let common: Set<string> | undefined;
  for (const head of heads) {
    const seen = new Set<string>(), stack = [head];
    while (stack.length) {
      const id = stack.pop()!; if (seen.has(id)) continue;
      seen.add(id); for (const parent of graph.get(id)?.parents ?? []) stack.push(parent);
    }
    common = common ? new Set([...common].filter(id => seen.has(id))) : seen;
  }
  const maximal = new Set(common);
  // Common ancestry is downward closed; every non-maximal node is a parent of another common node.
  for (const id of common!) for (const parent of graph.get(id)?.parents ?? []) maximal.delete(parent);
  return maximal.size === 1 ? [...maximal][0] : null;
}
