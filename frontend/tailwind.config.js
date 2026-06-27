/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // ── Theme C · "Ink & Petrol" ───────────────────────
        // Visual refresh (2026-06-25). Cooler neutral canvas so white
        // cards lift off the page; petrol/teal `primary` is the new
        // FUNCTIONAL accent (buttons, active states, links, selected
        // rows); brass `accent` is demoted to a brand-only accent
        // (logo, eyebrows, doc numbers, soft backgrounds).

        // ── Canvas ─────────────────────────────────────────
        bg: "#eef0ec",
        surface: "#ffffff",
        "surface-2": "#f4f6f3", // table headers, nested/inset surfaces, search fields
        "surface-dim": "#e3e6e0",

        border: {
          DEFAULT: "#d6d9d2",
          subtle: "#e3e6e0",
          strong: "#c2c6bd",
        },

        // ── Ink ────────────────────────────────────────────
        ink: {
          DEFAULT: "#11140f",
          secondary: "#414539",
          muted: "#767b6e",
        },

        // ── Primary (petrol/teal) — NEW functional accent ──
        primary: {
          DEFAULT: "#16695f",
          soft: "#e1efed", // selected-row bg, soft chips, month-P&L card
          ink: "#0c3f39", // text on primary-soft
        },

        // ── Accent — brass retired (owner 2026-06-27 "不要黄铜了"). The
        //    `accent` token now points at the petrol/teal family so every
        //    legacy `*-accent*` utility reads as petrol in one change. Kept as
        //    an alias (rather than find/replacing ~hundreds of call sites) so
        //    the sweep is total and reversible.
        accent: {
          DEFAULT: "#16695f", // was brass #a16a2e → petrol
          soft: "#e1efed", // was #f3ece0 → petrol soft
          bright: "#7cc4b7", // was gold #d8a85a → light teal (legible on the dark sidebar/hero)
          hover: "#0c3f39", // was #8a5a26 → petrol ink
          ink: "#0c3f39", // was #5a3a14 → petrol ink (text on accent-soft)
        },

        // ── Sidebar palette (dark ink-green slab) ──────────
        sidebar: {
          DEFAULT: "#13201c",
          ink: "#e7eae4",
          "ink-muted": "#8c968a",
          "ink-soft": "#6f786d",
          border: "rgba(231,234,228,0.12)",
          hover: "rgba(231,234,228,0.06)",
          active: "rgba(22,105,95,0.22)", // petrol 22%
        },

        // ── Semantic ───────────────────────────────────────
        synced: { DEFAULT: "#2f8a5b", bg: "#e2f0e9" },
        err: { DEFAULT: "#b23a3a", bg: "#f8eaea" },
        expired: { bg: "#f7e9e9", text: "#7a2222" },
        warning: { bg: "#f6efd9", text: "#6e4d12" },
      },
      fontFamily: {
        // Unified to the native system font (Segoe UI on Windows, SF on macOS)
        // per owner request — matches the vendored SCM's --font-system so the
        // whole ERP reads as one normal system typeface. No web fonts.
        body: ["system-ui", "-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Roboto", '"Helvetica Neue"', "Arial", "sans-serif"],
        display: ["system-ui", "-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Roboto", '"Helvetica Neue"', "Arial", "sans-serif"],
        // Was JetBrains Mono — replaced with Plus Jakarta Sans for the
        // small uppercase eyebrow labels and numeric chips. Tabular
        // alignment of figures is restored via a `font-variant-numeric:
        // tabular-nums` rule on `.font-mono` in index.css. The alias
        // name stays `mono` to avoid touching 440 call sites; the
        // *meaning* is now "data / labels / numbers".
        mono: ["system-ui", "-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Roboto", '"Helvetica Neue"', "Arial", "sans-serif"],
        // Money / financial figures only — IBM Plex Mono gives ledger-grade
        // tabular digits so amounts line up by decimal across rows and in the
        // detail drawers. Applied via `font-money` on amount cells ONLY; the
        // rest of the ERP stays on the system typeface (owner's house style).
        money: ['"IBM Plex Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
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
