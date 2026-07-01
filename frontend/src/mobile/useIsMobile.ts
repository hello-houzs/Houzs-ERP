import { useEffect, useState } from "react";

/** True on phone/tablet-portrait widths (matches the app's `lg` breakpoint).
 *  Override on a desktop browser to preview the mobile app: add `?mobile=1` to
 *  the URL (or `?mobile=0` to force desktop). The choice sticks for the session. */
export function useIsMobile(breakpoint = 1024): boolean {
  const forced = readForcedOverride();
  const [mobile, setMobile] = useState(
    () => forced ?? (typeof window !== "undefined" && window.innerWidth < breakpoint),
  );
  useEffect(() => {
    if (forced != null) {
      setMobile(forced);
      return;
    }
    const onResize = () => setMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint, forced]);
  return mobile;
}

function readForcedOverride(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const q = new URLSearchParams(window.location.search).get("mobile");
    if (q === "1") localStorage.setItem("hz_force_mobile", "1");
    else if (q === "0") localStorage.removeItem("hz_force_mobile");
    if (localStorage.getItem("hz_force_mobile") === "1") return true;
    if (q === "0") return false;
    return null;
  } catch {
    return null;
  }
}
