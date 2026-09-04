/** Exact file names admitted by every privileged release-handoff extractor. */
export const SPLIT_HANDOFF_FILES = Object.freeze([
  '"handoff.json"',
  '"release-files.sha256"',
  '"package.json"',
  '"server.json"',
  '"release-notes.md"',
  '"npm-package/enquire-mcp-npm.tgz"',
  '"npm-package/npm-package-manifest.json"',
  '"scripts/check-release-integrity.mjs"',
  '"scripts/npm-package-artifact.mjs"',
  '"scripts/lib/entrypoint.mjs"',
  '".github/scripts/release-mcpb-github-transaction.sh"',
  'f"artifacts/enquire-mcp-basic-{version}.mcpb"',
  'f"artifacts/enquire-mcp-basic-{version}.mcpb.sha256"',
  'f"artifacts/enquire-mcp-basic-{version}.mcpb.provenance.json"',
  'f"artifacts/enquire-mcp-basic-{version}.content-manifest.json"',
  'f"artifacts/enquire-mcp-basic-{version}.sbom.cdx.json"',
  'f"artifacts/enquire-mcp-basic-{version}.third-party-licenses.json"'
]);

/** Exact verify-job outputs that downstream protected environments may consume. */
export const SPLIT_VERIFY_OUTPUTS = Object.freeze({
  deadline_epoch: `\${{ steps.deadline.outputs.epoch }}`,
  version: `\${{ steps.handoff.outputs.version }}`,
  tag: `\${{ steps.handoff.outputs.tag }}`,
  source_sha: `\${{ steps.handoff.outputs.source_sha }}`,
  channel: `\${{ steps.handoff.outputs.channel }}`,
  build_run_id: `\${{ steps.mcpb_candidate.outputs.build_run_id }}`,
  npm_build_run_attempt: `\${{ steps.mcpb_candidate.outputs.npm_build_run_attempt }}`,
  release_body_sha256: `\${{ steps.release_body.outputs.sha256 }}`,
  release_body_bytes: `\${{ steps.release_body.outputs.bytes }}`,
  release_body_chars: `\${{ steps.release_body.outputs.chars }}`,
  handoff_artifact_id: `\${{ steps.handoff_upload.outputs.artifact-id }}`,
  handoff_digest: `\${{ steps.handoff_upload.outputs.artifact-digest }}`
});

/** Exact ownership of every release step that crosses a publication boundary. */
export const SPLIT_STEP_OWNERS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["Download exact CI-gated Basic MCPB release asset", "verify"],
  ["Re-verify exact CI-gated Basic MCPB release asset", "verify"],
  ["Resolve npm dist-tag from version", "verify"],
  ["Prepare deterministic Basic release records", "verify"],
  ["Materialize bounded GitHub Release body", "verify"],
  ["Preflight existing GitHub release and every Basic asset before npm", "verify"],
  ["Assemble exact verified release handoff", "verify"],
  ["Upload exact verified release handoff", "verify"],
  ["Publish exact npm tarball with Trusted Publishing or verify rerun", "npm_publish"],
  ["Verify exact npm provenance without credentials", "npm_publish"],
  ["Prepare draft GitHub Release", "github_release"],
  ["Upload and publish the exact reviewed GitHub Release transaction", "github_release"],
  ["Publish exact stable manifest to MCP Registry with OIDC", "mcp_registry"]
]);

/** Reviewed hashes for exact split-release step bodies, environments, and verify inventory. */
export const SPLIT_CONTRACT_SHA256 = Object.freeze({
  integritySource: "42af7c5c8ffc3519dec9c33487d67bfdef52ebf8d7d417baeb8cdea07ad21879",
  npmArtifactSource: "673b0c2ad935b052f348c7a63e8c1b464dd944520ebcfc62a238b5b4f29df0a8",
  entrypointSource: "31e3b1af3bf48c88149b20cd71fa948e492e8e0db45551ae7271a01c36d37b1b",
  githubTransactionSource: "7c0e384376eab7c7c37f4372164d729f61e50078812b5ec5eaead0d3afba58af",
  verifySteps: "43f0861dc7347b86d3ce0fee770405f5d8d4c14633aa3b4aed08be39e459f916",
  handoffAssembly: "f49b2c2d0606904e119a3efc624d218cc7069aa5d72edfbee06d16495dc136b0",
  handoffDownload: "ee5b5d8684995ee24286368da80bf58180077b310571173ef5b42fc1020d1569",
  npmPublishRun: "06bc8ccfdd3a34e4c13a189b767eacda6db0c698ad027fd1577d2dfde9008483",
  npmPublishEnv: "e2bbe5914d5e745436e45e8e80b1a2cc174dd7892e2dd37a277b0d9cb022c30e",
  npmProvenanceRun: "40d0777f017b01c6863c0ac9c1a4ec010d50edb55dfb391a68aab87d941d0766",
  npmProvenanceEnv: "b8375b64405b385f2356f12a8b69f0520c44cde60febebd89983f09064509967",
  githubPrepareRun: "addfd1978559c9668fc20843211562881db99dce6e64dded7374119dca4223dc",
  githubPrepareEnv: "3d4684f4fa6612fb11ff060e25cbb4515d4774f5e9dfc065e6db8f3138d4d129",
  githubTransactionRun: "1abda8f3283f580f2365ed10b3e07b6594d845d8547c48179db120219ff3a077",
  githubTransactionEnv: "1f95dc113eefedaf2a4ed9e05dd9c912a7902ef12c23dc61529da49ef71c3152",
  registryRun: "90547f7522ffb879aa178efc6196e0eb510a9ce4edad8844abd2e92da596e473",
  registryEnv: "45228bb542d06b27d97926a4ffb7db0a6d04edaa3a3f9a891c7e75ea585a6795"
});

const reviewedIdentityBody = (entries: ReadonlyArray<readonly [string, string]>) =>
  [
    "set -euo pipefail",
    "{",
    ...entries.map(([hash, path]) => `  printf '%s  %s\\n' '${hash}' '${path}'`),
    "} | sha256sum -c -"
  ].join("\n");

/** Exact privileged-source identity bodies consumed by the three downstream jobs. */
export const SPLIT_REVIEWED_IDENTITY_BODIES = Object.freeze([
  reviewedIdentityBody([
    [SPLIT_CONTRACT_SHA256.integritySource, "scripts/check-release-integrity.mjs"],
    [SPLIT_CONTRACT_SHA256.npmArtifactSource, "scripts/npm-package-artifact.mjs"],
    [SPLIT_CONTRACT_SHA256.entrypointSource, "scripts/lib/entrypoint.mjs"]
  ]),
  reviewedIdentityBody([
    [SPLIT_CONTRACT_SHA256.githubTransactionSource, ".github/scripts/release-mcpb-github-transaction.sh"],
    [SPLIT_CONTRACT_SHA256.integritySource, "scripts/check-release-integrity.mjs"],
    [SPLIT_CONTRACT_SHA256.entrypointSource, "scripts/lib/entrypoint.mjs"]
  ]),
  reviewedIdentityBody([
    [SPLIT_CONTRACT_SHA256.integritySource, "scripts/check-release-integrity.mjs"],
    [SPLIT_CONTRACT_SHA256.entrypointSource, "scripts/lib/entrypoint.mjs"]
  ])
]);
