import { useEffect, useState } from "react";
import { Package } from "lucide-react";
import { api } from "../api/client";
import { cn } from "../lib/utils";

interface Props {
  awardId: number;
  hasImage: boolean;
  alt: string;
  className?: string;
  /** Render only the icon placeholder when there's no image. */
  iconSize?: number;
}

/**
 * Auth-aware award image — fetches the protected /api/awards/:id/image
 * route as a blob and renders it via blob: URL since <img src> can't
 * carry the bearer token. Same pattern used by POD photos.
 */
export function AwardImage({
  awardId,
  hasImage,
  alt,
  className,
  iconSize = 32,
}: Props) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!hasImage) return;
    let url: string | null = null;
    let cancelled = false;
    api
      .fetchBlobUrl(`/api/awards/${awardId}/image`)
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
  }, [awardId, hasImage]);

  if (!hasImage || !src) {
    return (
      <div className={cn("grid place-items-center", className)}>
        <Package size={iconSize} className="text-accent/40" />
      </div>
    );
  }
  return <img src={src} alt={alt} className={className} loading="lazy" />;
}
