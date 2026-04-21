const { createDefaultPreset } = require("ts-jest");

module.exports = {
  ...createDefaultPreset(),
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  moduleFileExtensions: ["ts", "js"],
  moduleNameMapper: {
    "^@xenova/transformers$": "<rootDir>/tests/__stubs__/xenova-transformers.js",
    "^@anthropic-ai/sdk$": "<rootDir>/tests/__stubs__/anthropic-sdk.js",
  },
};
