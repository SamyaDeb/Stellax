/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        stella: {
          bg: "#0a0b0f",
          surface: "#131520",
          border: "#1f2231",
          muted: "#7b7f95",
          accent: "#5b8cff",
          long: "#2ebd85",
          short: "#e5484d",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [],
};
