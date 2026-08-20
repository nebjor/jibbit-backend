const { loadEnv } = require("@medusajs/utils");
loadEnv("test", process.cwd());

module.exports = {
  transform: {
    "^.+\\.[jt]s$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "typescript", decorators: true },
        },
      },
    ],
  },
  testEnvironment: "node",
  moduleFileExtensions: ["js", "ts", "json"],
  modulePathIgnorePatterns: ["dist/", "<rootDir>/.medusa/"],
  setupFiles: ["./integration-tests/setup.js"],
};

const UNIT_TEST_MATCH = ["**/src/**/__tests__/**/*.unit.spec.[jt]s"];

if (process.env.TEST_TYPE === "integration:http") {
  module.exports.testMatch = ["**/integration-tests/http/*.spec.[jt]s"];
} else if (process.env.TEST_TYPE === "integration:modules") {
  module.exports.testMatch = ["**/src/modules/*/__tests__/**/*.[jt]s"];
} else {
  // Default (auch bei TEST_TYPE=unit): nur die Unit-Tests.
  //
  // Ohne diesen Zweig fiel ein blankes `npx jest` auf Jests Standard-
  // testMatch zurueck und zog `integration-tests/http/health.spec.ts` mit
  // hinein. Der braucht eine laufende Postgres-Instanz UND
  // NODE_OPTIONS=--experimental-vm-modules und scheitert sonst — ein
  // Rotlicht, das nichts ueber den Code aussagt. Integrationstests laufen
  // ueber `npm run test:integration:http` mit gesetztem TEST_TYPE.
  module.exports.testMatch = UNIT_TEST_MATCH;
}
