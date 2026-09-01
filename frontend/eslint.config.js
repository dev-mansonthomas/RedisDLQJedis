// @ts-check
const eslint = require("@eslint/js");
const tseslint = require("typescript-eslint");
const angular = require("angular-eslint");

module.exports = tseslint.config(
  {
    files: ["**/*.ts"],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      ...tseslint.configs.stylistic,
      ...angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      "@angular-eslint/directive-selector": [
        "error",
        {
          type: "attribute",
          prefix: "app",
          style: "camelCase",
        },
      ],
      "@angular-eslint/component-selector": [
        "error",
        {
          type: "element",
          prefix: "app",
          style: "kebab-case",
        },
      ],
      // The API lives on the page's own origin under `/api` (see src/app/api.config.ts): nginx
      // proxies it in Docker, the dev server proxies it under `npm start`. An absolute backend URL
      // at a call site bypasses both proxies and turns the call cross-origin, which is how 19 of
      // them accumulated. Import API_BASE instead.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/^https?:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?\\/api/]",
          message:
            "Hardcoded backend URL. Import API_BASE from api.config.ts and build a relative path.",
        },
        {
          selector:
            "TemplateElement[value.raw=/^https?:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?\\/api/]",
          message:
            "Hardcoded backend URL. Import API_BASE from api.config.ts and build a relative path.",
        },
      ],
    },
  },
  {
    files: ["**/*.html"],
    extends: [
      ...angular.configs.templateRecommended,
      ...angular.configs.templateAccessibility,
    ],
    rules: {},
  }
);
