import { defineConfig } from "vitest/config";

// Two projects in one run. "page": every *.test.js loads the control page into happy-dom and
// drives it against a fake daemon (tests/harness.js for the old index.html, tests/harness-lit.js
// for src/). No page test may reach the real ryuod on 127.0.0.1:8746: the base URL below does
// not resolve, and tests/setup.js fails any request the fake does not serve. "unit": the
// *.test.ts files test the pure modules in node, with no DOM and no setup file.
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "page",
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
      },
      {
        extends: true,
        test: { name: "unit", include: ["tests/**/*.test.ts"], environment: "node" },
      },
    ],
  },
});
