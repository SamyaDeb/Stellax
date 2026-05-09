/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        stella: {
          bg: "#08090d",
          surface: "#0f1118",
          "surface-2": "#161822",
          border: "#1e2030",
          muted: "#6b7194",
          accent: "#f5a623",
          "accent-hover": "#ffc04d",
          gold: "#f5a623",
          "gold-light": "#ffd666",
          "gold-dark": "#c77f00",
          long: "#2ebd85",
          short: "#e5484d",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      borderRadius: {
        xl: "12px",
        "2xl": "16px",
      },
    },
  },
  plugins: [],
};
