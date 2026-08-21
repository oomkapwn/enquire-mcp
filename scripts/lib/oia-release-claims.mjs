function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function stripHeredocBodies(source) {
  const output = [];
  const pending = [];
  for (const line of source.split("\n")) {
    const active = pending[0];
    if (active !== undefined) {
      const candidate = active.stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === active.delimiter) pending.shift();
      continue;
    }
    output.push(line);
    for (const match of line.matchAll(/<<(-)?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/gu)) {
      pending.push({ delimiter: match[3], stripTabs: match[1] === "-" });
    }
  }
  return output.join("\n");
}

/** Tokenize executable shell commands while ignoring comments and heredoc bodies. */
export function shellCommandTokens(source) {
  const commands = [];
  let command = [];
  let token = "";
  let quote = null;
  const input = stripHeredocBodies(source);

  const endToken = () => {
    if (token.length > 0) command.push(token);
    token = "";
  };
  const endCommand = () => {
    endToken();
    if (command.length > 0) commands.push(command);
    command = [];
  };

  for (let index = 0; index < input.length; index++) {
    const character = input[index] ?? "";
    const next = input[index + 1] ?? "";
    if (quote === "single") {
      if (character === "'") quote = null;
      else token += character;
      continue;
    }
    if (quote === "double") {
      if (character === '"') {
        quote = null;
      } else if (character === "\\" && next === "\n") {
        index++;
      } else if (character === "\\" && ['"', "\\", "$", "`"].includes(next)) {
        token += next;
        index++;
      } else {
        token += character;
      }
      continue;
    }

    if (character === "'") {
      quote = "single";
      continue;
    }
    if (character === '"') {
      quote = "double";
      continue;
    }
    if (character === "\\" && next === "\n") {
      index++;
      continue;
    }
    if (character === "\\" && next.length > 0) {
      token += next;
      index++;
      continue;
    }
    if (character === "#" && token.length === 0) {
      while (index + 1 < input.length && input[index + 1] !== "\n") index++;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      endToken();
      continue;
    }
    if (character === "\n" || character === ";" || character === "(" || character === ")") {
      endCommand();
      continue;
    }
    if ((character === "&" && next === "&") || (character === "|" && next === "|")) {
      endCommand();
      index++;
      continue;
    }
    if (character === "|" || character === "&") {
      endCommand();
      continue;
    }
    token += character;
  }
  endCommand();
  return commands;
}

function executableName(token) {
  return token.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
}

function isAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token);
}

function isEnvExecutable(token) {
  return executableName(token) === "env";
}

function isTimeoutExecutable(token) {
  return token === "$TIMEOUT_BIN" || /^\$\{TIMEOUT_BIN\}$/u.test(token) || executableName(token) === "timeout";
}

function isNpmExecutable(token) {
  if (token === "$NPM_BIN" || /^\$\{NPM_BIN\}$/u.test(token)) return true;
  return /^(?:npm|npm\.cmd|npm\.exe|npm\.ps1)$/u.test(executableName(token));
}

function npmExecutableIndex(tokens) {
  let index = 0;
  while (isAssignment(tokens[index] ?? "")) index++;

  if (isEnvExecutable(tokens[index] ?? "")) {
    index++;
    while (index < tokens.length) {
      const token = tokens[index] ?? "";
      if (isAssignment(token) || token.startsWith("-") || /^\$\{[A-Za-z_][A-Za-z0-9_]*\[@\]\}$/u.test(token)) {
        index++;
        continue;
      }
      break;
    }
  }

  if (isTimeoutExecutable(tokens[index] ?? "")) {
    index++;
    while ((tokens[index] ?? "").startsWith("-")) index++;
    if (index >= tokens.length) return -1;
    index++; // timeout duration
  }

  return isNpmExecutable(tokens[index] ?? "") ? index : -1;
}

function literalCount(source, needle) {
  return source.split(needle).length - 1;
}

function hasExactProvenanceConfigScrub(source) {
  const executable = stripHeredocBodies(source);
  const lowercaseCanonicalization = `NPM_ENV_KEY_CANONICAL=\${NPM_ENV_KEY,,}`;
  const hyphenCanonicalization = `NPM_ENV_KEY_CANONICAL=\${NPM_ENV_KEY_CANONICAL//-/_}`;
  const scrubArm = "npm_config_provenance|npm_config_provenance_file)";
  const unsetAppend = 'NPM_ENV_UNSETS+=("--unset=$NPM_ENV_KEY")';
  const lowercaseIndex = executable.indexOf(lowercaseCanonicalization);
  const hyphenIndex = executable.indexOf(hyphenCanonicalization, lowercaseIndex + lowercaseCanonicalization.length);
  const caseIndex = executable.indexOf('case "$NPM_ENV_KEY_CANONICAL" in', hyphenIndex + hyphenCanonicalization.length);
  const scrubIndex = executable.indexOf(scrubArm, caseIndex);
  const unsetIndex = executable.indexOf(unsetAppend, scrubIndex + scrubArm.length);
  return (
    literalCount(executable, lowercaseCanonicalization) === 1 &&
    literalCount(executable, hyphenCanonicalization) === 1 &&
    literalCount(executable, scrubArm) === 1 &&
    literalCount(executable, unsetAppend) === 1 &&
    lowercaseIndex >= 0 &&
    hyphenIndex > lowercaseIndex &&
    caseIndex > hyphenIndex &&
    scrubIndex > caseIndex &&
    unsetIndex > scrubIndex
  );
}

const provenanceIdentityCarriers = ["NPM_ID_TOKEN", "SIGSTORE_ID_TOKEN", "GITLAB_CI"];

function hasIdTokenWrite(workflow, publishJob) {
  const effective = publishJob.permissions === undefined ? workflow.permissions : publishJob.permissions;
  const permissions = asRecord(effective);
  return permissions?.["id-token"] === "write";
}

function slsaGeneratorJobs(jobs) {
  const result = [];
  for (const [jobName, value] of Object.entries(jobs)) {
    const job = asRecord(value);
    if (
      typeof job?.uses === "string" &&
      /^slsa-framework\/slsa-github-generator\/.+\.ya?ml@[0-9a-f]{40}$/u.test(job.uses)
    ) {
      result.push(jobName);
    }
  }
  return result;
}

function jobNeeds(job, dependency) {
  if (typeof job.needs === "string") return job.needs === dependency;
  return Array.isArray(job.needs) && job.needs.includes(dependency);
}

/**
 * Derive the release workflow's earned provenance level from executable YAML
 * semantics rather than comments or regex matches elsewhere in the file.
 */
export function inspectReleaseProvenanceWorkflow(workflowValue) {
  const workflow = asRecord(workflowValue);
  const jobs = asRecord(workflow?.jobs);
  const publishJob = asRecord(jobs?.npm_publish);
  const problems = [];
  if (workflow === null || jobs === null || publishJob === null) {
    return {
      earnedLevel: 0,
      hasIdTokenWrite: false,
      publishCommandCount: 0,
      provenancePublishCommandCount: 0,
      linkedGeneratorCount: 0,
      problems: ["release workflow must contain one jobs.npm_publish mapping"]
    };
  }

  const publishCommands = [];
  const trustedPublishingCommands = [];
  const explicitProvenanceCommands = [];
  const closedProvenanceEnvCommands = [];
  const provenanceScrubCommands = [];
  const closedIdentityCarrierCommands = [];
  const steps = Array.isArray(publishJob.steps) ? publishJob.steps : [];
  let publicationStep = null;
  for (const stepValue of steps) {
    const step = asRecord(stepValue);
    if (typeof step?.run !== "string") continue;
    for (const tokens of shellCommandTokens(step.run)) {
      const executableIndex = npmExecutableIndex(tokens);
      if (executableIndex < 0 || tokens[executableIndex + 1] !== "publish") continue;
      publishCommands.push(tokens);
      publicationStep = step;
      const args = tokens.slice(executableIndex + 2);
      const commandPrefix = tokens.slice(0, executableIndex);
      const hasExactProvenanceFlag = args.filter((arg) => arg === "--provenance").length === 1;
      const hasProvenanceFileFlag = args.some(
        (arg) => arg === "--provenance-file" || arg.startsWith("--provenance-file=")
      );
      const hasClosedProvenanceEnv =
        commandPrefix.filter((token) => token === "NPM_CONFIG_PROVENANCE=true").length === 1;
      const hasProvenanceScrub = hasExactProvenanceConfigScrub(step.run);
      const stepEnv = asRecord(step.env);
      const hasClosedIdentityCarriers = provenanceIdentityCarriers.every(
        (carrier) =>
          commandPrefix.filter((token) => token === `--unset=${carrier}`).length === 1 && stepEnv?.[carrier] === ""
      );
      if (hasExactProvenanceFlag && !hasProvenanceFileFlag) explicitProvenanceCommands.push(tokens);
      if (hasClosedProvenanceEnv) closedProvenanceEnvCommands.push(tokens);
      if (hasProvenanceScrub) provenanceScrubCommands.push(tokens);
      if (hasClosedIdentityCarriers) closedIdentityCarrierCommands.push(tokens);
      if (
        args[0] === "$PACKAGE_TARBALL" &&
        args.includes("--access") &&
        args.includes("public") &&
        args.includes("--tag") &&
        args.includes("$CHANNEL") &&
        args.includes("--ignore-scripts") &&
        hasExactProvenanceFlag &&
        !hasProvenanceFileFlag &&
        hasClosedProvenanceEnv &&
        hasProvenanceScrub &&
        hasClosedIdentityCarriers
      ) {
        trustedPublishingCommands.push(tokens);
      }
    }
  }

  if (publishCommands.length !== 1)
    problems.push(`expected one executable npm publish command, found ${publishCommands.length}`);
  if (trustedPublishingCommands.length !== 1) {
    problems.push(
      `expected one lifecycle-disabled Trusted Publishing command, found ${trustedPublishingCommands.length}`
    );
  }
  if (explicitProvenanceCommands.length !== 1) {
    problems.push(`expected exactly one npm publish --provenance flag, found ${explicitProvenanceCommands.length}`);
  }
  if (closedProvenanceEnvCommands.length !== 1) {
    problems.push(
      `expected one npm publish command to pin NPM_CONFIG_PROVENANCE=true, found ${closedProvenanceEnvCommands.length}`
    );
  }
  if (provenanceScrubCommands.length !== 1) {
    problems.push(
      `expected one npm publish step to scrub both provenance and provenance-file config aliases, found ${provenanceScrubCommands.length}`
    );
  }
  if (closedIdentityCarrierCommands.length !== 1) {
    problems.push(
      "expected one npm publish command to pin empty step env and unconditionally unset NPM_ID_TOKEN, SIGSTORE_ID_TOKEN, and GITLAB_CI"
    );
  }
  const idToken = hasIdTokenWrite(workflow, publishJob);
  if (!idToken) problems.push("jobs.npm_publish must effectively grant id-token: write");
  const permissions = asRecord(publishJob.permissions);
  if (
    permissions === null ||
    JSON.stringify(Object.keys(permissions).sort()) !== JSON.stringify(["actions", "contents", "id-token"]) ||
    permissions.actions !== "read" ||
    permissions.contents !== "read" ||
    permissions["id-token"] !== "write"
  ) {
    problems.push("jobs.npm_publish must use the exact read/read/OIDC permission boundary");
  }
  const environment = asRecord(publishJob.environment);
  if (
    environment === null ||
    JSON.stringify(Object.keys(environment)) !== JSON.stringify(["name"]) ||
    environment.name !== "npm-publish"
  ) {
    problems.push("jobs.npm_publish must use the protected npm-publish environment");
  }
  if (!jobNeeds(publishJob, "verify")) problems.push("jobs.npm_publish must depend on the exact verify handoff");
  const handoff = steps.map(asRecord).find((step) => step?.name === "Download and verify exact release handoff");
  if (
    typeof handoff?.run !== "string" ||
    !handoff.run.includes("actions/artifacts/$HANDOFF_ARTIFACT_ID/zip") ||
    !handoff.run.includes('"$ACTUAL_HANDOFF_DIGEST" != "$EXPECTED_HANDOFF_DIGEST"') ||
    !handoff.run.includes("unexpected release handoff inventory") ||
    !handoff.run.includes("sha256sum -c release-files.sha256")
  ) {
    problems.push("jobs.npm_publish must verify the exact immutable release handoff before OIDC use");
  }
  const setup = steps
    .map(asRecord)
    .find((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/setup-node@"));
  const setupWith = asRecord(setup?.with);
  if (
    typeof setup?.uses !== "string" ||
    !/^actions\/setup-node@[0-9a-f]{40}$/u.test(setup.uses) ||
    setupWith?.["node-version"] !== 24
  ) {
    problems.push("jobs.npm_publish must use one SHA-pinned GitHub-hosted Node 24 setup");
  }
  if (
    typeof publicationStep?.run !== "string" ||
    !publicationStep.run.includes('PACKAGE_TARBALL="$PWD/npm-package/enquire-mcp-npm.tgz"') ||
    !publicationStep.run.includes('NPM_MINIMUM_VERSION="11.5.1"')
  ) {
    problems.push("jobs.npm_publish must bind the absolute canonical tarball and npm >=11.5.1");
  }
  const publicationEnv = asRecord(publicationStep?.env);
  if (
    publicationEnv?.NPM_TOKEN !== undefined ||
    publicationEnv?.NODE_AUTH_TOKEN !== undefined ||
    JSON.stringify(publishJob).includes("secrets.")
  ) {
    problems.push("jobs.npm_publish must not expose a long-lived npm credential");
  }
  if (
    steps.some((stepValue) => {
      const step = asRecord(stepValue);
      return (
        (typeof step?.uses === "string" && (step.uses.startsWith("actions/checkout@") || step.uses.startsWith("./"))) ||
        (typeof step?.run === "string" && step.run.includes("$GITHUB_WORKSPACE"))
      );
    })
  ) {
    problems.push("jobs.npm_publish must not checkout or execute the repository workspace");
  }

  const generatorJobs = slsaGeneratorJobs(jobs);
  const linkedGenerators = generatorJobs.filter((jobName) => jobNeeds(publishJob, jobName));
  const earnsL2 = problems.length === 0 && trustedPublishingCommands.length === 1;
  const earnedLevel = earnsL2 && linkedGenerators.length === 1 ? 3 : earnsL2 ? 2 : 0;
  return {
    earnedLevel,
    hasIdTokenWrite: idToken,
    publishCommandCount: publishCommands.length,
    provenancePublishCommandCount: trustedPublishingCommands.length,
    linkedGeneratorCount: linkedGenerators.length,
    problems
  };
}
