import "@testing-library/jest-dom/vitest";
import { vi, beforeEach } from "vitest";

// jsdom doesn't ship matchMedia
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
});
