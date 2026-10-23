import { defineConfig } from "vitest/config";

// Every test loads index.html into happy-dom and runs its inline script against a fake
// daemon (tests/harness.js). No test may reach the real ryuod on 127.0.0.1:8746: the base
// URL below does not resolve, and tests/setup.js fails any request the fake does not serve.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    environment: "happy-dom",
    environmentOptions: {
      happyDOM: {
        url: "http://ryuod.invalid/",
        settings: {
          disableJavaScriptFileLoading: true,
          disableCSSFileLoading: true,
          disableIframePageLoading: true,
          handleDisabledFileLoadingAsSuccess: true,
        },
      },
    },
    setupFiles: ["tests/setup.js"],
  },
});
