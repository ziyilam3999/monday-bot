module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  moduleFileExtensions: ["ts", "js"],
  moduleNameMapper: {
    "^@xenova/transformers$": "<rootDir>/tests/__stubs__/xenova-transformers.js",
  },
};
