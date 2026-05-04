/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // ── Canvas ─────────────────────────────────────────
        // Warm cream paper canvas — slight green-yellow undertone
        // pulled from the brand's "Nature" axis.
        bg: "#f5f4ee",
        surface: "#ffffff",
        "surface-dim": "#ecebe2",

        border: {
          DEFAULT: "#e0ddd0",
          subtle: "#ecebe2",
          strong: "#cdc8b8",
        },

        // ── Ink ────────────────────────────────────────────
        // Nature Black is the brand anchor (#111810).
        ink: {
          DEFAULT: "#111810", // brand: Nature Black
          secondary: "#4a534a",
          muted: "#8a8e85",
        },

        // ── Brass accent ───────────────────────────────────
        // Hand-rubbed brass — the "Colour X" pairing for Nature Black.
        // Chosen to evoke furniture hardware, distinct from any other
        // ERP green/blue/purple, and to leave the success/error semantic
        // greens & reds free for status.
        accent: {
          DEFAULT: "#a16a2e",
          soft: "#f5ecd9",
          hover: "#8a5a26",
          ink: "#5a3a14",
        },

        // ── Sidebar palette (cream slab — interior brand mode) ─
        // Inverted from the cover-page direction so a dark/black logo
        // sits naturally on a warm interior surface, matching the
        // light pages in the Houzs Century brand book.
        sidebar: {
          DEFAULT: "#fafaf6",
          ink: "#111810", // Nature Black for primary text
          "ink-muted": "#6b7167",
          "ink-soft": "#8a8e85",
          border: "#e0ddd0",
          hover: "#f1efe6",
          active: "#f5ecd9", // pale brass tint
        },

        // ── Semantic ───────────────────────────────────────
        synced: { DEFAULT: "#3f7d4f", bg: "#eaf2ec" },
        err: { DEFAULT: "#a83232", bg: "#f7e9e9" },
        expired: { bg: "#f7e9e9", text: "#7a2222" },
        warning: { bg: "#f6efd9", text: "#6e4d12" },
      },
      fontFamily: {
        // Manrope = closest open analog to Acumin Variable Concept.
        // Geometric, variable, same workhorse character the brand book
        // describes, with a slightly friendlier humanist edge.
        body: ['"Manrope"', "system-ui", "sans-serif"],
        display: ['"Manrope"', "system-ui", "sans-serif"],
        // Was JetBrains Mono — replaced with Plus Jakarta Sans for the
        // small uppercase eyebrow labels and numeric chips. Tabular
        // alignment of figures is restored via a `font-variant-numeric:
        // tabular-nums` rule on `.font-mono` in index.css. The alias
        // name stays `mono` to avoid touching 440 call sites; the
        // *meaning* is now "data / labels / numbers".
        mono: ['"Plus Jakarta Sans"', "system-ui", "sans-serif"],
      },
      letterSpacing: {
        brand: "0.18em",
        wider: "0.06em",
      },
      boxShadow: {
        // Soft "stone" shadow — matches the cream canvas without
        // looking like a generic Material drop shadow.
        stone: "0 1px 0 rgba(17, 24, 16, 0.04), 0 4px 18px -8px rgba(17, 24, 16, 0.12)",
        slab: "0 1px 0 rgba(17, 24, 16, 0.06), 0 12px 32px -16px rgba(17, 24, 16, 0.25)",
        brass: "0 0 0 1px rgba(161, 106, 46, 0.3), 0 1px 4px rgba(161, 106, 46, 0.18)",
      },
      keyframes: {
        // Page-load reveal: a slow lift from below with fade.
        rise: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        // Brass shimmer for skeleton states — the metal catching light.
        shimmer: {
          "0%": { backgroundPosition: "-400px 0" },
          "100%": { backgroundPosition: "400px 0" },
        },
        // Toast: slide down from above + fade in.
        toastIn: {
          "0%": { opacity: "0", transform: "translateY(-12px) scale(0.97)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        // Modal panel: scale-up + fade.
        modalIn: {
          "0%": { opacity: "0", transform: "scale(0.96)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        rise: "rise 420ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "fade-in": "fadeIn 600ms ease both",
        shimmer: "shimmer 1.6s linear infinite",
        "toast-in": "toastIn 220ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "modal-in": "modalIn 180ms cubic-bezier(0.16, 1, 0.3, 1) both",
      },
    },
  },
  plugins: [],
};
