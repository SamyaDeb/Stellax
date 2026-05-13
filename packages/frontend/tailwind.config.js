/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        stella: {
          bg: "#0b0e14",
          surface: "#111520",
          "surface-2": "#161b28",
          border: "rgba(255,255,255,0.07)",
          muted: "#8892a4",
          accent: "#4f8eff",
          "accent-hover": "#6ba3ff",
          gold: "#f0a742",
          "gold-light": "#f5c060",
          "gold-dark": "#c07820",
          long: "#00d47e",
          short: "#f0404a",
        },
      },
      fontFamily: {
        sans: ["JetBrains Mono", "Fira Code", "monospace"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
      borderRadius: {
        DEFAULT: "3px",
        sm: "2px",
        md: "3px",
        lg: "4px",
        xl: "5px",
        "2xl": "5px",
        full: "9999px",
      },
    },
  },
  plugins: [],
};
