/** Canonical workflow command for the bounded npm-ci helper. */
export const NPM_CI_HELPER_COMMAND = "node scripts/npm-ci-with-retry.mjs";

/** Canonical workflow step name for the bounded npm-ci helper. */
export const NPM_CI_INSTALL_STEP_NAME = "Install deps (npm ci with retry)";

/** Canonical bounded workflow command for the dependency audit. */
export const NPM_CI_AUDIT_COMMAND = "/usr/bin/timeout --kill-after=10s 300s npm run check:audit";

/** Reviewed byte identity of the bounded npm-ci helper source. */
export const NPM_CI_HELPER_SOURCE_SHA256 = "e2984fee26d261069446231feedbe7776ce3343e4c8dacde666cb77ab72e4298";

/** Reviewed byte identity of the shared entrypoint guard. */
export const NPM_CI_ENTRYPOINT_SOURCE_SHA256 = "31e3b1af3bf48c88149b20cd71fa948e492e8e0db45551ae7271a01c36d37b1b";

/** Exact dependency-installing workflow jobs and their composed budgets. */
export const NPM_CI_WORKFLOW_JOB_TIMEOUTS = [
  ["ci.yml", "lint", 5],
  ["ci.yml", "test", 20],
  ["ci.yml", "test-windows", 20],
  ["ci.yml", "test-macos", 20],
  ["ci.yml", "coverage", 10],
  ["ci.yml", "docs", 10],
  ["ci.yml", "oia", 10],
  ["ci.yml", "smoke", 10],
  ["ci.yml", "protocol-conformance-matrix", 20],
  ["ci.yml", "npm-package", 20],
  ["ci.yml", "package-consumer-matrix", 30],
  ["ci.yml", "mcpb-basic-package", 40],
  ["ci.yml", "mcpb-basic-matrix", 30],
  ["ci.yml", "audit", 12],
  ["publish-docs.yml", "build", 10],
  ["release.yml", "verify", 240]
] as const;

/** Shared problem identity for the independent workflow mirror. */
export const NPM_CI_WORKFLOW_PROBLEM =
  "workflow npm-ci installs must retain the exact bounded helper inventory and composed job budgets";

/** Shared problem identity for the bounded helper implementation. */
export const NPM_CI_HELPER_POLICY_PROBLEM =
  "npm-ci helper must retain POSIX 3x60s, Windows 1x180s, 10s cleanup and the configured 240-second maximum";

/** Exact matrix-provided script shell expression. */
export const NPM_CI_MATRIX_SCRIPT_SHELL = `\${{ matrix.script_shell }}`;

/** Exact matrix-provided runner expression. */
export const NPM_CI_MATRIX_OS = `\${{ matrix.os }}`;

/** Exact matrix-provided Node version expression. */
export const NPM_CI_MATRIX_NODE_VERSION = `\${{ matrix.node-version }}`;

/** Exact unconditional cleanup expression used by the smoke job. */
export const NPM_CI_ALWAYS_CONDITION = `\${{ always() }}`;

/** Exact main-branch condition used by the documentation job. */
export const NPM_CI_MAIN_REF_CONDITION = `\${{ github.ref == 'refs/heads/main' }}`;

/** Exact job-level environments for dependency-installing jobs that need one. */
export const NPM_CI_JOB_ENVIRONMENTS = new Map<string, Readonly<Record<string, string>>>([
  ["ci.yml#test", { NPM_CONFIG_ENGINE_STRICT: "true" }],
  [
    "ci.yml#test-windows",
    {
      NPM_CONFIG_ENGINE_STRICT: "true",
      NPM_CONFIG_SCRIPT_SHELL: "C:\\Program Files\\Git\\bin\\bash.exe"
    }
  ],
  ["ci.yml#smoke", { NPM_CONFIG_ENGINE_STRICT: "true" }],
  [
    "ci.yml#protocol-conformance-matrix",
    { NPM_CONFIG_ENGINE_STRICT: "true", NPM_CONFIG_SCRIPT_SHELL: NPM_CI_MATRIX_SCRIPT_SHELL }
  ],
  [
    "ci.yml#package-consumer-matrix",
    { NPM_CONFIG_ENGINE_STRICT: "true", NPM_CONFIG_SCRIPT_SHELL: NPM_CI_MATRIX_SCRIPT_SHELL }
  ],
  ["ci.yml#mcpb-basic-package", { NPM_CONFIG_ENGINE_STRICT: "true", NPM_CONFIG_SCRIPT_SHELL: "/bin/bash" }],
  [
    "ci.yml#mcpb-basic-matrix",
    { NPM_CONFIG_ENGINE_STRICT: "true", NPM_CONFIG_SCRIPT_SHELL: NPM_CI_MATRIX_SCRIPT_SHELL }
  ],
  ["ci.yml#npm-package", { NPM_CONFIG_ENGINE_STRICT: "true", NPM_CONFIG_SCRIPT_SHELL: "/bin/bash" }],
  ["release.yml#verify", { BASH_ENV: "" }]
]);

/** Exact runners for every dependency-installing workflow job. */
export const NPM_CI_JOB_RUNNERS = new Map<string, string>([
  ["ci.yml#lint", "ubuntu-latest"],
  ["ci.yml#test", "ubuntu-latest"],
  ["ci.yml#test-windows", "windows-2025"],
  ["ci.yml#test-macos", "macos-latest"],
  ["ci.yml#coverage", "ubuntu-latest"],
  ["ci.yml#docs", "ubuntu-latest"],
  ["ci.yml#oia", "ubuntu-latest"],
  ["ci.yml#smoke", "ubuntu-latest"],
  ["ci.yml#protocol-conformance-matrix", NPM_CI_MATRIX_OS],
  ["ci.yml#npm-package", "ubuntu-latest"],
  ["ci.yml#package-consumer-matrix", NPM_CI_MATRIX_OS],
  ["ci.yml#mcpb-basic-package", "ubuntu-latest"],
  ["ci.yml#mcpb-basic-matrix", NPM_CI_MATRIX_OS],
  ["ci.yml#audit", "ubuntu-latest"],
  ["publish-docs.yml#build", "ubuntu-latest"],
  ["release.yml#verify", "ubuntu-latest"]
]);

/** Exact setup-node inputs that must precede each bounded npm-ci helper. */
export const NPM_CI_SETUP_INPUTS = new Map<string, Readonly<Record<string, unknown>>>([
  ["ci.yml#lint", { "node-version": 22, cache: "npm" }],
  [
    "ci.yml#test",
    { "node-version": NPM_CI_MATRIX_NODE_VERSION, cache: "npm", "cache-dependency-path": "package-lock.json" }
  ],
  ["ci.yml#test-windows", { "node-version": "22.13.0", cache: "npm", "cache-dependency-path": "package-lock.json" }],
  ["ci.yml#test-macos", { "node-version": 22, cache: "npm", "cache-dependency-path": "package-lock.json" }],
  ["ci.yml#coverage", { "node-version": 22, cache: "npm" }],
  ["ci.yml#docs", { "node-version": 22, cache: "npm" }],
  ["ci.yml#oia", { "node-version": 22, cache: "npm" }],
  ["ci.yml#smoke", { "node-version": "22.13.0", cache: "npm" }],
  [
    "ci.yml#protocol-conformance-matrix",
    { "node-version": "22.13.0", cache: "npm", "cache-dependency-path": "package-lock.json" }
  ],
  ["ci.yml#npm-package", { "node-version": "22.13.0", cache: "npm", "cache-dependency-path": "package-lock.json" }],
  [
    "ci.yml#package-consumer-matrix",
    { "node-version": "22.13.0", cache: "npm", "cache-dependency-path": "package-lock.json" }
  ],
  [
    "ci.yml#mcpb-basic-package",
    { "node-version": "22.13.0", cache: "npm", "cache-dependency-path": "package-lock.json" }
  ],
  [
    "ci.yml#mcpb-basic-matrix",
    { "node-version": "22.13.0", cache: "npm", "cache-dependency-path": "package-lock.json" }
  ],
  ["ci.yml#audit", { "node-version": 22, cache: "npm" }],
  ["publish-docs.yml#build", { "node-version": 22, cache: "npm" }],
  [
    "release.yml#verify",
    {
      "node-version": "22.13.0",
      "registry-url": "https://registry.npmjs.org",
      cache: "npm",
      "cache-dependency-path": "package-lock.json"
    }
  ]
]);

/**
 * Reviewed semantic digests of every step before each bounded npm-ci helper.
 * The lint digest normalizes only the relational raw-receipt carrier value;
 * the bootstrap receipt independently validates that value and all other
 * preinstall bytes remain part of this digest.
 */
export const NPM_CI_PREINSTALL_DIGESTS = new Map<string, string>([
  ["ci.yml#lint", "0acf2d9e58fa56c861244b4bfb0de4a2276e26c7bcca9603dd601d5eb5b98e90"],
  ["ci.yml#test", "0b00c055e9a2707a37043a75423ce6b68004d5750b872ce6cf40e3dcadd1c4db"],
  ["ci.yml#test-windows", "da943043234f9a375c085802079dc10cf411019cbc03b4747de9af178dc6a9ca"],
  ["ci.yml#test-macos", "bad0645f602426986294fd032eac707a60440bd897f27a5105c05d54f054cc4e"],
  ["ci.yml#coverage", "559a7e13a198905e6ac358a1914d6e9fa087ad055f55b27c380ae171424f3d6b"],
  ["ci.yml#docs", "559a7e13a198905e6ac358a1914d6e9fa087ad055f55b27c380ae171424f3d6b"],
  ["ci.yml#oia", "559a7e13a198905e6ac358a1914d6e9fa087ad055f55b27c380ae171424f3d6b"],
  ["ci.yml#smoke", "44d845e567d5c3e9e38e265a970b7d2cbce33377b7ba78137effe85ca99e9110"],
  ["ci.yml#protocol-conformance-matrix", "7ec0b012fca4c5f77005997e6e4c43ce04b44e55dbf1d1f7ffcc313d1d3c552f"],
  ["ci.yml#npm-package", "7ec0b012fca4c5f77005997e6e4c43ce04b44e55dbf1d1f7ffcc313d1d3c552f"],
  ["ci.yml#package-consumer-matrix", "7ec0b012fca4c5f77005997e6e4c43ce04b44e55dbf1d1f7ffcc313d1d3c552f"],
  ["ci.yml#mcpb-basic-package", "7ec0b012fca4c5f77005997e6e4c43ce04b44e55dbf1d1f7ffcc313d1d3c552f"],
  ["ci.yml#mcpb-basic-matrix", "7ec0b012fca4c5f77005997e6e4c43ce04b44e55dbf1d1f7ffcc313d1d3c552f"],
  ["ci.yml#audit", "559a7e13a198905e6ac358a1914d6e9fa087ad055f55b27c380ae171424f3d6b"],
  ["publish-docs.yml#build", "d6d9a6ab99423dc354d027dbb535c854e9e95836acb250c1f4bfa21d28a7d302"],
  ["release.yml#verify", "add39e96ceac3beefa408d899638c13ef462ee9a85ca184bfb7a9a48c0a95144"]
]);

/** Reviewed semantic digests of every literal npm-bearing workflow command inventory. */
export const NPM_CI_COMMAND_DIGESTS = new Map<string, string>([
  ["ci.yml#lint", "85cb42a92181265d2458eb8b7a7aa737143eda0c7d4a6dd3349b4955e49adfcf"],
  ["ci.yml#test", "530375edb43b6e8f47eae64f7d01e5ebef01db57516588af24110937ac31e5d1"],
  ["ci.yml#test-windows", "1fee0ec9bd5a5e93e87f317b82dcae8ffc24e8dbacb9dad21ccfe05f4c50d2a6"],
  ["ci.yml#test-macos", "530375edb43b6e8f47eae64f7d01e5ebef01db57516588af24110937ac31e5d1"],
  ["ci.yml#coverage", "3e8733a08a6fe5b873546ac5284f4ffaadb924dd4dd04cd8b9557cd56837efe7"],
  ["ci.yml#docs", "31ee2597c84a4669a98435b0e9bfb95b685b10aaa70205ad8749647e2ab43be5"],
  ["ci.yml#oia", "03789343a6bc223162c6f26dba4e44d7704d14ecfadb083f32065825f48a8d6b"],
  ["ci.yml#smoke", "4158b622c017e1e9463d27732c2ef0d4277807309f5e18a3867fb6500837585a"],
  ["ci.yml#protocol-conformance-matrix", "4158b622c017e1e9463d27732c2ef0d4277807309f5e18a3867fb6500837585a"],
  ["ci.yml#npm-package", "d221317662f47cffbf2eadf71360f8802984099a2f8a791bab4e2460f210603d"],
  ["ci.yml#package-consumer-matrix", "f46f0ccb90328555e5e9f898433db6bbb6b23930aa52170916f60e2b2c6e1d73"],
  ["ci.yml#mcpb-basic-package", "72f8f9db912e223c63e5245d948adc6c23299a60262bd7ba22d2c106654181f6"],
  ["ci.yml#mcpb-basic-matrix", "428a7037595e3943656994b9fd69aec7639287929316ef9ffbe017c37490ae82"],
  ["ci.yml#audit", "257a09114a4e895df831ace40f70115b66d7ae38a41eb166ff5dca10df1b245c"],
  ["dist-tag-cleanup.yml#cleanup", "b1dcb901eb22fd286c299b8e3ee1ac9f21cb529665be150c9a476b5a305e4ce0"],
  ["publish-docs.yml#build", "476bc2a8aea0d3def4c805b616058ba0c4aea7f9d940e73a5d9da4b5b977cfba"],
  ["release.yml#verify", "d99c2e59a073a1f2ef5f670be90ab5662c2b45c2800b215e9259d9d6e1353496"],
  ["release.yml#npm_publish", "2486876be9061db2f8004e4923042784ea13f2a7de780861a50d6959ab651a8d"],
  ["release.yml#github_release", "108ecb3285e85905af15541a079ba1877e7713da88bb51e3c0f8f00f30aa5dec"],
  ["release.yml#mcp_registry", "d70a7be8dfcff2a2e062a88235709adc0186487cda56100c9e33f3ec423f385a"]
]);

/** Reviewed semantic digests of every step before each bounded dependency audit. */
export const NPM_CI_PREAUDIT_DIGESTS = new Map<string, string>([
  ["ci.yml#audit", "877eb535025aaf14a917f52fd1a871e38a2c26836a6df19f5cc42a31f32eb6f6"],
  ["release.yml#verify", "cc04209af39705adeddc6e5eaa10f53a6a259bd0b84efefb2dd5d5c0471f31c7"]
]);

/** Dependency-installing jobs that intentionally use one exact Bash default. */
export const NPM_CI_BASH_DEFAULT_JOBS = new Set([
  "ci.yml#test-windows",
  "ci.yml#protocol-conformance-matrix",
  "ci.yml#package-consumer-matrix",
  "ci.yml#mcpb-basic-matrix"
]);
