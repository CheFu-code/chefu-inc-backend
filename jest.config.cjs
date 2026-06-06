module.exports = {
  clearMocks: true,
  moduleFileExtensions: ["js", "json", "ts"],
  roots: ["<rootDir>/test"],
  testEnvironment: "node",
  testRegex: ".*\\.spec\\.ts$",
  transform: {
    "^.+\\.(t|j)s$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.spec.json",
      },
    ],
  },
};
