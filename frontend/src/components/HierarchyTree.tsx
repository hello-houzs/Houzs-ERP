import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * Generic hierarchical tree renderer. Takes any flat list of nodes
 * with `id` + `parent_id` and renders an indented tree with chevron
 * expanders + vertical guide lines. Each row's contents are
 * delegated to the caller via `renderNode`.
 *
 * Used by the Sales Team page for the "List" view (List = a sorted
 * indented tree, not a flat table — matches the boss's mockup).
 */

export interface TreeNode<T> {
  id: number;
  parent_id: number | null;
  data: T;
  children: TreeNode<T>[];
  depth: number;
}

export function buildTree<T extends { id: number }>(
  items: T[],
  getParentId: (item: T) => number | null,
): TreeNode<T>[] {
  const byId = new Map<number, TreeNode<T>>();
  for (const item of items) {
    byId.set(item.id, {
      id: item.id,
      parent_id: getParentId(item),
      data: item,
      children: [],
      depth: 0,
    });
  }
  const roots: TreeNode<T>[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_id != null ? byId.get(node.parent_id) : null;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Set depths recursively so render-time logic doesn't have to walk again.
  function setDepth(n: TreeNode<T>, d: number) {
    n.depth = d;
    for (const c of n.children) setDepth(c, d + 1);
  }
  for (const r of roots) setDepth(r, 0);
  return roots;
}

interface HierarchyTreeProps<T extends { id: number }> {
  /** Flat node list. */
  items: T[];
  /** Returns the parent id of a node, or null for roots. */
  getParentId: (item: T) => number | null;
  /** Stable sort within siblings (e.g. by position level then name). */
  sortChildren?: (a: T, b: T) => number;
  /** Renders the right-side content of a row (everything but the
   *  chevron + indent guides). */
  renderNode: (item: T, opts: { hasChildren: boolean; depth: number }) => ReactNode;
  /** Called on row click. Default: toggles expand/collapse. */
  onRowClick?: (item: T) => void;
  /** External expand/collapse override. When provided, the tree
   *  defers to this map; when omitted, it manages state internally. */
  expanded?: Set<number>;
  setExpanded?: (next: Set<number>) => void;
  /** Defaults to expanded — tree starts open. */
  defaultExpanded?: boolean;
}

export function HierarchyTree<T extends { id: number }>({
  items,
  getParentId,
  sortChildren,
  renderNode,
  onRowClick,
  expanded: extExpanded,
  setExpanded: setExtExpanded,
  defaultExpanded = true,
}: HierarchyTreeProps<T>) {
  const tree = useMemo(() => {
    const built = buildTree(items, getParentId);
    if (sortChildren) {
      function sortRec(nodes: TreeNode<T>[]) {
        nodes.sort((a, b) => sortChildren!(a.data, b.data));
        for (const n of nodes) sortRec(n.children);
      }
      sortRec(built);
    }
    return built;
  }, [items, getParentId, sortChildren]);

  const [internalExpanded, setInternalExpanded] = useState<Set<number>>(() => {
    if (!defaultExpanded) return new Set<number>();
    const all = new Set<number>();
    for (const it of items) all.add(it.id);
    return all;
  });
  // Re-seed when the input list grows so newly-added nodes are
  // expanded by default (or stay collapsed if the page is collapsed).
  useEffect(() => {
    if (!defaultExpanded) return;
    setInternalExpanded((cur) => {
      const next = new Set(cur);
      for (const it of items) if (!next.has(it.id)) next.add(it.id);
      return next;
    });
  }, [items, defaultExpanded]);

  const expanded = extExpanded ?? internalExpanded;
  const setExpanded = setExtExpanded ?? setInternalExpanded;

  function toggle(id: number) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  }

  // Flatten the tree to a render list, respecting expand state, so
  // virtual indent guides stay aligned per row.
  const rendered: { node: TreeNode<T>; visible: boolean }[] = [];
  function walk(nodes: TreeNode<T>[]) {
    for (const n of nodes) {
      rendered.push({ node: n, visible: true });
      if (expanded.has(n.id) && n.children.length > 0) {
        walk(n.children);
      }
    }
  }
  walk(tree);

  return (
    <ul className="divide-y divide-border-subtle">
      {rendered.map(({ node }) => {
        const hasChildren = node.children.length > 0;
        const open = expanded.has(node.id);
        return (
          <li
            key={node.id}
            onClick={() => onRowClick?.(node.data)}
            className={cn(
              "group flex items-center gap-1.5 px-3 py-2 transition-colors",
              "hover:bg-accent-soft/30",
              onRowClick && "cursor-pointer",
            )}
          >
            {/* Indent guides */}
            {Array.from({ length: node.depth }).map((_, i) => (
              <span
                key={i}
                aria-hidden
                className="ml-2 mr-1 inline-block h-7 w-2 border-l border-border-subtle"
              />
            ))}
            {/* Chevron */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (hasChildren) toggle(node.id);
              }}
              className={cn(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-muted",
                hasChildren && "hover:bg-bg/70 hover:text-ink",
                !hasChildren && "invisible",
              )}
              aria-label={open ? "Collapse" : "Expand"}
            >
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {/* Caller-provided content */}
            <div className="min-w-0 flex-1">
              {renderNode(node.data, { hasChildren, depth: node.depth })}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ── Helpers used by SalesTeam org-chart toolbar ──────────────

export function expandAllIds<T extends { id: number }>(items: T[]): Set<number> {
  const s = new Set<number>();
  for (const it of items) s.add(it.id);
  return s;
}

export function collapseAllIds(): Set<number> {
  return new Set<number>();
}
