import { Fragment, type ReactNode } from "react";
import { splitHighlight } from "./utils";

/**
 * Renders `text` with every case-insensitive occurrence of `query` wrapped in a
 * bold <mark>. Shared by BOTH the desktop Cmd+K palette (GlobalSearch) and the
 * mobile search palette (MobileSearch) so the "bold the matched keyword"
 * behaviour is identical everywhere.
 *
 * The <mark> is styled inline (transparent background, inherited colour, bold
 * weight) so it reads as an emphasised run of the SAME text — not a yellow
 * highlighter block — matching the ERP's restrained palette. Callers on either
 * platform can override via `className`.
 */
export function HighlightedText({
  text,
  query,
  className,
}: {
  text: string | null | undefined;
  query: string | null | undefined;
  className?: string;
}): ReactNode {
  const segments = splitHighlight(text, query);
  return (
    <>
      {segments.map((seg, i) =>
        seg.match ? (
          <mark
            key={i}
            className={className}
            style={{
              background: "transparent",
              color: "inherit",
              fontWeight: 700,
            }}
          >
            {seg.text}
          </mark>
        ) : (
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
    </>
  );
}
