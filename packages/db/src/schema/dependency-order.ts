// ── Dependency ordering (pure) ────────────────────────────────────────────
//
// Schema sync orders table DDL by foreign-key dependency: a child table (the
// one declaring `@db.rel.FK`) depends on its parent (the referenced table).
// Parents must exist before a child is created (MySQL/PostgreSQL emit inline
// FK constraints), and children must be dropped before their parents.
//
// `topoOrder` is Tarjan's strongly-connected-components algorithm over a
// name-sorted node list, so the result is a pure function of the graph — not
// of import order — and mutually dependent tables (A ⇄ B via nullable FKs)
// come out as one group that the executor handles atomically.

/** A directed edge `from → to`: `from` depends on `to` (child → parent). */
export type TDependencyEdge = readonly [from: string, to: string];

/**
 * Orders `nodes` so that dependencies come first. Returns the strongly-
 * connected components in dependency order: every group appears AFTER each
 * group it depends on (parents first). Singleton groups are ordinary tables;
 * groups of size > 1 are cycles. Members are name-sorted.
 *
 * - Edges referencing a name outside `nodes` are ignored (external tables
 *   impose no ordering).
 * - Self-loops are ignored (a self-referential FK is legal inline everywhere).
 * - Deterministic: nodes and adjacency lists are sorted by name before the
 *   traversal, so two processes with different inventory orders compute the
 *   same plan.
 */
export function topoOrder(nodes: Iterable<string>, edges: Iterable<TDependencyEdge>): string[][] {
  const names = [...new Set(nodes)].toSorted();
  const nodeSet = new Set(names);
  const adjacency = new Map<string, Set<string>>(names.map((n) => [n, new Set<string>()]));
  for (const [from, to] of edges) {
    if (from === to || !nodeSet.has(from) || !nodeSet.has(to)) {
      continue;
    }
    adjacency.get(from)!.add(to);
  }

  // Tarjan's SCC — emits a component only after every component reachable
  // from it has been emitted, i.e. dependencies (edge targets) first.
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const order: string[][] = [];
  let counter = 0;

  const visit = (node: string): void => {
    index.set(node, counter);
    lowlink.set(node, counter);
    counter++;
    stack.push(node);
    onStack.add(node);

    for (const next of [...adjacency.get(node)!].toSorted()) {
      if (!index.has(next)) {
        visit(next);
        lowlink.set(node, Math.min(lowlink.get(node)!, lowlink.get(next)!));
      } else if (onStack.has(next)) {
        lowlink.set(node, Math.min(lowlink.get(node)!, index.get(next)!));
      }
    }

    if (lowlink.get(node) === index.get(node)) {
      const group: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        group.push(member);
      } while (member !== node);
      group.sort();
      order.push(group);
    }
  };

  for (const name of names) {
    if (!index.has(name)) {
      visit(name);
    }
  }

  return order;
}

/**
 * The dependents closure of `seeds`: the seeds themselves plus every node
 * that depends on one of them — directly or through other dependents — along
 * `edges` (`from` depends on `to`). A fixed point over the edge list, so the
 * edges may come in any order. Schema sync uses it over the removed-table
 * graph: the removed tables that block a drop, plus their own removed
 * children, which must go first.
 */
export function reachable(seeds: Iterable<string>, edges: Iterable<TDependencyEdge>): Set<string> {
  const out = new Set(seeds);
  const edgeList = [...edges];
  for (let grew = out.size > 0; grew; ) {
    grew = false;
    for (const [from, to] of edgeList) {
      if (out.has(to) && !out.has(from)) {
        out.add(from);
        grew = true;
      }
    }
  }
  return out;
}
