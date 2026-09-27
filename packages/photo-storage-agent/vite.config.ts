import { TESTS_WITH_TIMEOUT_ENV, withTestTimeout } from "@gadgets/scripts/vitest-task";

/** The agent runs on Node (it is not a Worker), so its suites use the platform test runner. */
export default {
  run: {
    tasks: {
      build: { command: "tsc -p ." },
      test: { command: withTestTimeout("node --test 'test/**/*.test.ts'"), env: TESTS_WITH_TIMEOUT_ENV },
    },
  },
};
