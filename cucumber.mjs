const configuration = {
  paths: ["features/**/*.feature"],
  import: ["tests/acceptance/steps.ts"],
  format: ["progress", "summary"],
  strict: true,
};

export default configuration;
