import { useEffect, useState } from "react";
import { api } from "../api/client";
import { cn } from "../lib/utils";

interface Props {
  userId: number | null | undefined;
  /** R2 key (or any truthy marker that the user has a picture). */
  hasImage?: boolean | string | null;
  name?: string | null;
  email?: string | null;
  size?: number;
  className?: string;
  /** Add a thin brass ring around the circle — used in podium / chips. */
  ring?: boolean;
}

function initialsFor(name?: string | null, email?: string | null): string {
  const src = (name || email || "").trim();
  if (!src) return "?";
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({
  userId,
  hasImage,
  name,
  email,
  size = 32,
  className,
  ring,
}: Props) {
  const enabled = !!userId && !!hasImage;
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSrc(null);
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    // R2 keys include a Date.now() prefix, so a new upload yields a new
    // key — append it as a cache-buster so the blob URL refreshes too.
    const cacheKey = typeof hasImage === "string" ? `?k=${encodeURIComponent(hasImage)}` : "";
    api
      .fetchBlobUrl(`/api/users/${userId}/profile-pic${cacheKey}`)
      .then((u) => {
        if (cancelled) {
          URL.revokeObjectURL(u);
        } else {
          url = u;
          setSrc(u);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [userId, enabled, hasImage]);

  const dim = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  const ringCls = ring ? "ring-2 ring-accent/40 ring-offset-2 ring-offset-bg" : "";

  if (src) {
    return (
      <img
        src={src}
        alt={name || email || "User"}
        style={dim}
        className={cn("rounded-full object-cover shrink-0", ringCls, className)}
        loading="lazy"
      />
    );
  }
  return (
    <div
      style={dim}
      className={cn(
        "rounded-full grid place-items-center bg-accent/15 text-accent font-semibold uppercase shrink-0 select-none",
        ringCls,
        className,
      )}
      aria-label={name || email || "User"}
    >
      {initialsFor(name, email)}
    </div>
  );
}
