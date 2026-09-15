// The unit suite only. Every spec under test/unit is fully mocked, so unlike the e2e specs
// it needs neither the mongodb-memory-server replica set nor serial execution — which is
// what makes it cheap enough to run from a pre-commit hook.
//
// `roots` is inherited unchanged: jest has to crawl src/ to work out which specs relate to a
// changed source file (`--findRelatedTests`). The e2e specs are excluded by testRegex instead,
// since `.e2e-spec.ts` has no dot before `spec` and so does not match.
//
// Plain CommonJS on purpose: a .ts config importing another .ts config makes Node reparse both
// as ESM and print a warning on every run, which would be noise in the git hooks.
const config = {
  ...require('./jest.config.ts').default,
  testRegex: '.*\\.spec\\.ts$',
};

delete config.globalSetup;
delete config.globalTeardown;
delete config.maxWorkers;

module.exports = config;
