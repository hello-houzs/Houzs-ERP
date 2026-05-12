import { type ReactNode } from "react";
import { buildTree, type TreeNode } from "./HierarchyTree";
import { cn } from "../lib/utils";

/**
 * Top-down org chart visualization. Renders nodes as cards laid out
 * horizontally per level, with simple connector lines drawn via
 * borders on the wrapping divs. No external charting library.
 *
 * Used by the Sales Team page's "Org Chart" toggle. The "List" toggle
 * uses the indented HierarchyTree component instead.
 */

interface OrgChartProps<T extends { id: number }> {
  items: T[];
  getParentId: (item: T) => number | null;
  sortChildren?: (a: T, b: T) => number;
  renderNode: (item: T) => ReactNode;
  onNodeClick?: (item: T) => void;
}

export function OrgChartView<T extends { id: number }>({
  items,
  getParentId,
  sortChildren,
  renderNode,
  onNodeClick,
}: OrgChartProps<T>) {
  const tree = buildTree(items, getParentId);
  if (sortChildren) {
    function sortRec(nodes: TreeNode<T>[]) {
      nodes.sort((a, b) => sortChildren!(a.data, b.data));
      for (const n of nodes) sortRec(n.children);
    }
    sortRec(tree);
  }

  if (tree.length === 0) {
    return (
      <div className="rounded-md border border-border bg-surface p-8 text-center text-[12px] text-ink-muted">
        No reps to chart.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border bg-surface p-6">
      <div className="flex flex-col items-center gap-12 min-w-fit">
        {tree.map((root) => (
          <Subtree
            key={root.id}
            node={root}
            renderNode={renderNode}
            onNodeClick={onNodeClick}
            isRoot
          />
        ))}
      </div>
    </div>
  );
}

function Subtree<T extends { id: number }>({
  node,
  renderNode,
  onNodeClick,
  isRoot,
}: {
  node: TreeNode<T>;
  renderNode: (item: T) => ReactNode;
  onNodeClick?: (item: T) => void;
  isRoot?: boolean;
}) {
  return (
    <div className="flex flex-col items-center">
      {/* Vertical connector from parent */}
      {!isRoot && (
        <div
          aria-hidden
          className="h-6 w-px bg-border"
        />
      )}
      <div
        onClick={() => onNodeClick?.(node.data)}
        className={cn(
          "rounded-md border border-border bg-surface px-3 py-2 shadow-stone transition-colors",
          onNodeClick && "cursor-pointer hover:border-accent/60 hover:bg-accent-soft/30",
        )}
      >
        {renderNode(node.data)}
      </div>
      {node.children.length > 0 && (
        <>
          {/* Stem from this node down to the horizontal bar */}
          <div aria-hidden className="h-6 w-px bg-border" />
          {/* Horizontal bar across children. Only rendered when there
              are 2+ to avoid an awkward 1px line under a single child. */}
          {node.children.length > 1 && (
            <div
              aria-hidden
              className="-mb-px h-px self-stretch bg-border"
              style={{
                marginLeft: "10%",
                marginRight: "10%",
              }}
            />
          )}
          <div className="flex items-start gap-6">
            {node.children.map((c) => (
              <Subtree
                key={c.id}
                node={c}
                renderNode={renderNode}
                onNodeClick={onNodeClick}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
