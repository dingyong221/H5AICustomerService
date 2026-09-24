#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pnpmCommand = 'pnpm';
const standaloneComposeCommand = process.env['H5CS_DOCKER_COMPOSE_BIN']?.trim();
const standaloneShellcheckCommand = process.env['H5CS_SHELLCHECK_BIN']?.trim();

class GateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GateError';
  }
}

const fail = (message) => {
  throw new GateError(message);
};

const log = (message) => process.stdout.write(`${message}\n`);

const run = (program, args, options = {}) => {
  const capture = options.capture ?? false;
  const allowFailure = options.allowFailure ?? false;
  let result;
  if (process.platform === 'win32' && program === pnpmCommand) {
    const commandLine = [program, ...args].join(' ');
    result = spawnSync(commandLine, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: capture ? 'pipe' : 'inherit',
      shell: true,
    });
  } else {
    result = spawnSync(program, args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: capture ? 'pipe' : 'inherit',
    });
  }
  if (result.error) fail(`Unable to run ${program}: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    const details = capture ? `\n${result.stderr || result.stdout}` : '';
    fail(`${program} ${args.join(' ')} failed with exit code ${result.status}.${details}`);
  }
  return result;
};

const git = (args, options = {}) => run('git', args, { capture: true, ...options });

const readJson = (path) => JSON.parse(readFileSync(resolve(repositoryRoot, path), 'utf8'));

const sha256Buffer = (value) => createHash('sha256').update(value).digest('hex');
const sha256File = (path) => sha256Buffer(readFileSync(path));

const trackedFiles = () =>
  git(['ls-files', '-z'])
    .stdout.split('\0')
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'en'));

const workspaceFiles = () =>
  git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .stdout.split('\0')
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'en'));

const parseArguments = (values) => {
  const result = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) {
      result._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
};

const assertVersionPolicy = (expectedVersion) => {
  const rootPackage = readJson('package.json');
  const version = expectedVersion ?? rootPackage.version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    fail(`Release version is not valid SemVer: ${version}`);
  }
  if (rootPackage.version !== version) {
    fail(`Root package version ${rootPackage.version} does not match ${version}.`);
  }
  if (rootPackage.packageManager !== 'pnpm@11.19.0') {
    fail('packageManager must remain pinned to pnpm@11.19.0 for v0.1.0 evidence.');
  }
  if (readFileSync(resolve(repositoryRoot, '.nvmrc'), 'utf8').trim() !== '24') {
    fail('.nvmrc must pin the release build major to Node.js 24.');
  }

  const packageFiles = trackedFiles().filter(
    (path) => path === 'package.json' || /^(?:apps|packages)\/[^/]+\/package\.json$/u.test(path),
  );
  for (const path of packageFiles) {
    const manifest = readJson(path);
    if (manifest.version !== undefined && manifest.version !== version) {
      fail(`${path} has version ${manifest.version}; expected ${version}.`);
    }
  }
  return version;
};

const assertPinnedActions = () => {
  const workflowFiles = workspaceFiles().filter((path) =>
    /^\.github\/workflows\/.*\.ya?ml$/u.test(path),
  );
  const unpinned = [];
  for (const path of workflowFiles) {
    const lines = readFileSync(resolve(repositoryRoot, path), 'utf8').split(/\r?\n/u);
    lines.forEach((line, index) => {
      const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)\s*(?:#.*)?$/u);
      if (match === null) return;
      const value = match[1];
      if (value.startsWith('./')) return;
      const separator = value.lastIndexOf('@');
      const ref = separator >= 0 ? value.slice(separator + 1) : '';
      if (!/^[0-9a-f]{40}$/u.test(ref)) unpinned.push(`${path}:${index + 1} ${value}`);
    });
  }
  if (unpinned.length > 0) {
    fail(`GitHub Actions must use full commit SHAs:\n${unpinned.join('\n')}`);
  }
};

const credentialPatterns = () => [
  {
    label: 'private key block',
    expression: new RegExp('-'.repeat(5) + 'BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-' + '{5}', 'u'),
  },
  {
    label: 'AWS access key',
    expression: new RegExp('\\b' + 'AKIA' + '[0-9A-Z]{16}\\b', 'u'),
  },
  {
    label: 'Tencent Cloud secret id',
    expression: new RegExp('\\b' + 'AKID' + '[A-Za-z0-9]{13,40}\\b', 'u'),
  },
  {
    label: 'GitHub token',
    expression: new RegExp('\\b' + 'gh' + '[pousr]_[A-Za-z0-9_]{20,}\\b', 'u'),
  },
  {
    label: 'OpenAI-style secret',
    expression: new RegExp('\\b' + 'sk-' + '(?:proj-)?[A-Za-z0-9_-]{20,}\\b', 'u'),
  },
];

const assertNoTrackedSecrets = () => {
  const forbiddenNames = workspaceFiles().filter((path) => {
    const normalized = path.replaceAll('\\', '/');
    if (/^\.env(?:\.|$)/u.test(normalized)) {
      return !/^\.env(?:\.[^.]+)*\.example$/u.test(normalized) && normalized !== '.env.example';
    }
    return (
      /(?:^|\/)(?:id_rsa|id_ed25519|known_hosts)$/u.test(normalized) ||
      /\.(?:key|p12|pfx)$/iu.test(normalized)
    );
  });
  if (forbiddenNames.length > 0) {
    fail(`Forbidden credential-like tracked files:\n${forbiddenNames.join('\n')}`);
  }

  const patterns = credentialPatterns();
  const findings = [];
  for (const path of workspaceFiles()) {
    const absolutePath = resolve(repositoryRoot, path);
    const details = statSync(absolutePath);
    if (!details.isFile() || details.size > 2 * 1024 * 1024) continue;
    const bytes = readFileSync(absolutePath);
    if (bytes.includes(0)) continue;
    const lines = bytes.toString('utf8').split(/\r?\n/u);
    lines.forEach((line, index) => {
      for (const pattern of patterns) {
        if (pattern.expression.test(line)) findings.push(`${path}:${index + 1} ${pattern.label}`);
      }
    });
  }
  if (findings.length > 0) fail(`Potential credential material found:\n${findings.join('\n')}`);
};

const assertNoHistoricalSecrets = () => {
  const history = git([
    'log',
    '--all',
    '--no-ext-diff',
    '--no-renames',
    '--pretty=format:commit:%H',
    '-p',
  ]).stdout;
  let commit = 'unknown';
  const findings = [];
  const patterns = credentialPatterns();
  for (const line of history.split(/\r?\n/u)) {
    if (line.startsWith('commit:')) {
      commit = line.slice('commit:'.length);
      continue;
    }
    for (const pattern of patterns) {
      if (pattern.expression.test(line)) findings.push(`${commit} ${pattern.label}`);
    }
  }
  if (findings.length > 0) {
    fail(
      `Potential credential material found in reachable Git history:\n${[...new Set(findings)].join('\n')}`,
    );
  }
};

const assertReleaseComposePolicy = () => {
  const composePath = resolve(repositoryRoot, 'infra/compose/docker-compose.release.yml');
  const environmentPath = resolve(repositoryRoot, 'infra/compose/release.env.example');
  const compose = readFileSync(composePath, 'utf8');
  const environment = readFileSync(environmentPath, 'utf8');
  const imageVariables = [
    'H5CS_API_IMAGE',
    'H5CS_WORKER_IMAGE',
    'H5CS_MERCHANT_WEB_IMAGE',
    'H5CS_CONSUMER_H5_IMAGE',
    'H5CS_OPS_WEB_IMAGE',
  ];
  for (const variable of imageVariables) {
    if (!compose.includes(`image: \${${variable}:?`)) {
      fail(`Release Compose must require ${variable}.`);
    }
    const match = environment.match(new RegExp(`^${variable}=([^\\r\\n]+)$`, 'mu'));
    if (match === null || !/^[^@\s]+@sha256:[0-9a-f]{64}$/u.test(match[1])) {
      fail(`${variable} in release.env.example must use an immutable @sha256 digest.`);
    }
  }
  const imageDeclarations = compose.match(/^\s+image:\s*.+$/gmu) ?? [];
  if (imageDeclarations.length !== imageVariables.length) {
    fail(`Release Compose must declare exactly ${imageVariables.length} immutable service images.`);
  }
  if (/^\s+build:\s*/gmu.test(compose)) {
    fail('Release Compose must not build images on the target host.');
  }
  const directImages = [...compose.matchAll(/^\s*image:\s*([^$\s][^\s]*)\s*$/gmu)].map(
    (match) => match[1],
  );
  const floating = directImages.filter((image) => !/@sha256:[0-9a-f]{64}$/u.test(image));
  if (floating.length > 0)
    fail(`Floating image references in release Compose: ${floating.join(', ')}`);

  const caTarget = '/etc/ssl/certs/h5cs-managed-mysql-ca.pem';
  const caHostPath = environment.match(/^H5CS_MYSQL_CA_HOST_FILE=(\/[\S]+)$/mu)?.[1];
  const caMount =
    compose.split(/^x-mysql-ca-volumes: &mysql-ca-volumes\s*$/mu)[1]?.split(/^services:/mu)[0] ??
    '';
  if (
    !caHostPath ||
    !caMount.includes('source: ${H5CS_MYSQL_CA_HOST_FILE:?') ||
    !caMount.includes(`target: ${caTarget}`) ||
    !caMount.includes('read_only: true')
  ) {
    fail('Release Compose must mount the managed MySQL CA read-only from an absolute host path.');
  }
  const services = compose.split(/^services:\s*$/mu)[1]?.split(/^networks:\s*$/mu)[0] ?? '';
  const headings = [...services.matchAll(/^  ([a-z][a-z0-9-]*):\s*$/gmu)];
  for (const name of ['api', 'worker', 'merchant-web', 'ops-web']) {
    const index = headings.findIndex((match) => match[1] === name);
    if (index < 0) fail(`Release Compose is missing ${name}.`);
    const service = services.slice(
      headings[index].index,
      headings[index + 1]?.index ?? services.length,
    );
    if (
      !service.includes(`MYSQL_TLS_CA_FILE: ${caTarget}`) ||
      !service.includes('volumes: *mysql-ca-volumes')
    ) {
      fail(`Release Compose ${name} must use the managed MySQL CA mount.`);
    }
  }

  const serviceEnvironmentContracts = new Map([
    [
      'api',
      {
        variable: 'H5CS_API_ENV_FILE',
        required: ['MYSQL_DATABASE_URL', 'OAUTH_ISSUER', 'WORKBUDDY_OPEN_API_CLIENT_SECRET'],
      },
    ],
    [
      'worker',
      {
        variable: 'H5CS_WORKER_ENV_FILE',
        required: ['MYSQL_DATABASE_URL', 'CONVERSATION_WORKER_ENABLED', 'MODEL_API_KEY'],
      },
    ],
    [
      'merchant-web',
      {
        variable: 'H5CS_MERCHANT_ENV_FILE',
        required: [
          'MYSQL_DATABASE_URL',
          'MERCHANT_PHONE_LOOKUP_KEY',
          'PUBLIC_CONVERSATION_ENABLED',
          'PUBLISH_MODEL_POLICY_VERSION',
        ],
      },
    ],
    [
      'ops-web',
      {
        variable: 'H5CS_OPS_ENV_FILE',
        required: [
          'MYSQL_DATABASE_URL',
          'OPS_ADMIN_PASSWORD_HASH',
          'OPS_SESSION_SIGNING_KEY',
          'MANAGEMENT_CONSOLE_URL',
        ],
      },
    ],
  ]);
  for (const [name, contract] of serviceEnvironmentContracts) {
    const index = headings.findIndex((match) => match[1] === name);
    const service = services.slice(
      headings[index].index,
      headings[index + 1]?.index ?? services.length,
    );
    const path = `/etc/h5-ai-customer-service/${name}.env`;
    const reference = '- ${' + contract.variable + ':-' + path + '}';
    if (!service.includes(reference))
      fail(`Release Compose ${name} must use ${contract.variable}.`);
    if (!environment.includes(`${contract.variable}=${path}`)) {
      fail(`release.env.example must point ${contract.variable} to its dedicated server file.`);
    }
    const template = readFileSync(
      resolve(repositoryRoot, `infra/compose/${name}.env.example`),
      'utf8',
    );
    for (const key of contract.required) {
      if (!new RegExp(`^${key}=`, 'mu').test(template)) {
        fail(`infra/compose/${name}.env.example must declare ${key}.`);
      }
    }
    if (name !== 'worker' && /^MODEL_API_KEY=/mu.test(template)) {
      fail(`MODEL_API_KEY must not be in the ${name} environment template.`);
    }
    if (name !== 'api' && /^WORKBUDDY_OPEN_API_CLIENT_SECRET=/mu.test(template)) {
      fail(`WorkBuddy client secret must not be in the ${name} environment template.`);
    }
  }
};

const assertRequiredReleaseDocuments = () => {
  const requirements = new Map([
    ['docs/release/v0.1.0-standard-release-checklist.md', ['仓库标准版本', '生产业务可用', 'SBOM']],
    ['docs/operations/release-and-rollback-runbook.md', ['回滚', 'previous', '验证']],
    ['docs/release/production-readiness.example.json', ['productionBusinessReadiness']],
  ]);
  for (const [path, markers] of requirements) {
    let content;
    try {
      content = readFileSync(resolve(repositoryRoot, path), 'utf8');
    } catch {
      fail(`Required release document is missing: ${path}`);
    }
    for (const marker of markers) {
      if (!content.includes(marker)) fail(`${path} is missing required marker: ${marker}`);
    }
  }
};

const assertWorkBuddyPackageStructure = (version) => {
  const directory = 'integrations/workbuddy';
  const metadata = readJson(`${directory}/connector-meta.json`);
  const connection = readJson(`${directory}/mcp.json`);
  const source = metadata.source;
  const servers = connection.mcpServers;
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(source ?? '') ||
    metadata.version !== version ||
    !servers ||
    Object.keys(servers).length !== 1 ||
    servers[source]?.type !== 'streamableHttp'
  ) {
    fail('WorkBuddy connector metadata and the single MCP server must match this release.');
  }
  const endpoint = new URL(servers[source].url);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.pathname !== '/mcp' ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  ) {
    fail('WorkBuddy MCP endpoint must be an HTTPS /mcp URL without embedded credentials.');
  }
  let icon;
  try {
    icon = readFileSync(resolve(repositoryRoot, directory, 'icon.svg'), 'utf8');
  } catch {
    fail('WorkBuddy connector requires icon.svg.');
  }
  if (
    Buffer.byteLength(icon, 'utf8') > 20_000 ||
    !/^<svg\s[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*viewBox="[^"]+"/u.test(
      icon.trim(),
    ) ||
    /<!DOCTYPE\b|<(?:script|foreignObject|style)\b|\bon[a-z]+\s*=|\b(?:href|xlink:href)\s*=|url\s*\(/iu.test(
      icon,
    )
  ) {
    fail('WorkBuddy icon.svg must be a small self-contained SVG without active or linked content.');
  }
};

const assertStaticPolicy = (expectedVersion) => {
  log('[gate] static release policy');
  const version = assertVersionPolicy(expectedVersion);
  assertPinnedActions();
  assertNoTrackedSecrets();
  assertNoHistoricalSecrets();
  assertReleaseComposePolicy();
  assertRequiredReleaseDocuments();
  assertWorkBuddyPackageStructure(version);
  git(['diff', '--check']);
  log(`[gate] static policy passed for v${version}`);
  return version;
};

const normalizedReferenceName = (name) => encodeURIComponent(name).replaceAll('%2F', '/');

const componentPurl = (name, version) =>
  `pkg:npm/${normalizedReferenceName(name)}@${encodeURIComponent(version)}`;

const licenseForDependency = (dependencyPath) => {
  if (typeof dependencyPath !== 'string' || dependencyPath.length === 0) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(join(dependencyPath, 'package.json'), 'utf8'));
    if (typeof manifest.license === 'string' && manifest.license.trim().length > 0) {
      return manifest.license.trim();
    }
    if (Array.isArray(manifest.licenses)) {
      const first = manifest.licenses.find((entry) => typeof entry?.type === 'string');
      return first?.type;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const collectComponents = (roots) => {
  const components = new Map();
  const visit = (name, dependency, scope) => {
    if (typeof dependency !== 'object' || dependency === null) return;
    const resolvedName = typeof dependency.from === 'string' ? dependency.from : name;
    const version = dependency.version;
    if (
      typeof resolvedName === 'string' &&
      typeof version === 'string' &&
      !version.startsWith('link:')
    ) {
      const purl = componentPurl(resolvedName, version);
      const prior = components.get(purl);
      const license = licenseForDependency(dependency.path);
      const component = {
        type: 'library',
        'bom-ref': purl,
        name: resolvedName,
        version,
        purl,
        scope: prior?.scope === 'required' || scope === 'required' ? 'required' : 'optional',
      };
      if (license !== undefined) component.licenses = [{ license: { name: license } }];
      components.set(purl, { ...prior, ...component });
    }
    for (const [childName, child] of Object.entries(dependency.dependencies ?? {})) {
      visit(childName, child, 'required');
    }
    for (const [childName, child] of Object.entries(dependency.optionalDependencies ?? {})) {
      visit(childName, child, 'optional');
    }
    for (const [childName, child] of Object.entries(dependency.devDependencies ?? {})) {
      visit(childName, child, 'optional');
    }
  };

  for (const root of roots) {
    for (const [name, dependency] of Object.entries(root.dependencies ?? {})) {
      visit(name, dependency, 'required');
    }
    for (const [name, dependency] of Object.entries(root.optionalDependencies ?? {})) {
      visit(name, dependency, 'optional');
    }
    for (const [name, dependency] of Object.entries(root.devDependencies ?? {})) {
      visit(name, dependency, 'optional');
    }
  }
  return [...components.values()].sort((left, right) =>
    left['bom-ref'].localeCompare(right['bom-ref']),
  );
};

const deterministicUuid = (seed) => {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const normalizeAudit = (audit) => ({
  schemaVersion: 1,
  metadata: audit.metadata ?? {},
  advisories: Object.values(audit.advisories ?? {})
    .map((advisory) => ({
      id: advisory.id,
      githubAdvisoryId: advisory.github_advisory_id,
      moduleName: advisory.module_name,
      severity: advisory.severity,
      title: advisory.title,
      url: advisory.url,
      vulnerableVersions: advisory.vulnerable_versions,
      patchedVersions: advisory.patched_versions,
      findings: advisory.findings,
    }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id), 'en')),
});

const writeJson = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

const generateEvidence = ({ allowDirty, expectedVersion, output }) => {
  const version = assertVersionPolicy(expectedVersion);
  const outputDirectory = resolve(repositoryRoot, output);
  mkdirSync(outputDirectory, { recursive: true });
  const existing = [
    'bom.cdx.json',
    'dependency-audit.json',
    'source-files.sha256',
    'release-manifest.json',
    'evidence.sha256',
  ].filter((name) => {
    try {
      statSync(join(outputDirectory, name));
      return true;
    } catch {
      return false;
    }
  });
  if (existing.length > 0)
    fail(`Evidence output must be empty; existing files: ${existing.join(', ')}`);

  const status = git(['status', '--porcelain=v1', '--untracked-files=all']).stdout.trim();
  const dirty = status.length > 0;
  if (dirty && !allowDirty) fail('Release evidence requires a clean Git worktree.');

  const commit = git(['rev-parse', 'HEAD']).stdout.trim();
  const reference =
    git(['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true }).stdout.trim() ||
    git(['describe', '--tags', '--exact-match'], { allowFailure: true }).stdout.trim() ||
    'detached';
  const commitTime = git(['show', '-s', '--format=%cI', 'HEAD']).stdout.trim();
  const pnpmVersion = run(pnpmCommand, ['--version'], { capture: true }).stdout.trim();

  const listResult = run(pnpmCommand, ['list', '--recursive', '--json', '--depth', 'Infinity'], {
    capture: true,
  });
  const dependencyRoots = JSON.parse(listResult.stdout);
  const components = collectComponents(dependencyRoots);
  if (components.length === 0) fail('SBOM generation produced no dependency components.');

  const bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${deterministicUuid(`${commit}:${version}`)}`,
    version: 1,
    metadata: {
      timestamp: commitTime,
      component: {
        type: 'application',
        'bom-ref': `pkg:generic/h5-ai-customer-service@${encodeURIComponent(version)}`,
        name: 'h5-ai-customer-service',
        version,
      },
      properties: [
        { name: 'h5cs:git-commit', value: commit },
        { name: 'h5cs:dirty-worktree', value: String(dirty) },
      ],
    },
    components,
  };
  const bomPath = join(outputDirectory, 'bom.cdx.json');
  writeJson(bomPath, bom);

  const auditResult = run(pnpmCommand, ['audit', '--json'], { capture: true, allowFailure: true });
  let audit;
  try {
    audit = normalizeAudit(JSON.parse(auditResult.stdout));
  } catch {
    fail(`Dependency audit did not return valid JSON: ${auditResult.stderr}`);
  }
  const vulnerabilityCounts = audit.metadata?.vulnerabilities ?? {};
  if ((vulnerabilityCounts.high ?? 0) > 0 || (vulnerabilityCounts.critical ?? 0) > 0) {
    fail('Dependency audit contains high or critical vulnerabilities.');
  }
  const auditPath = join(outputDirectory, 'dependency-audit.json');
  writeJson(auditPath, audit);

  const sourceManifest = trackedFiles()
    .map((path) => {
      if (path.includes('\n') || path.includes('\r'))
        fail(`Unsupported newline in tracked path: ${path}`);
      return `${sha256File(resolve(repositoryRoot, path))}  ${path.replaceAll('\\', '/')}`;
    })
    .join('\n');
  const sourcePath = join(outputDirectory, 'source-files.sha256');
  writeFileSync(sourcePath, `${sourceManifest}\n`, { encoding: 'utf8', flag: 'wx' });

  const manifest = {
    schemaVersion: 1,
    releaseKind: 'repository-standard-evidence',
    releaseVersion: version,
    repositoryBusinessReady: false,
    git: { commit, reference, dirty, commitTime },
    toolchain: {
      declaredNode: readFileSync(resolve(repositoryRoot, '.nvmrc'), 'utf8').trim(),
      actualNode: process.version,
      declaredPnpm: readJson('package.json').packageManager,
      actualPnpm: pnpmVersion,
    },
    evidence: {
      sbom: {
        path: 'bom.cdx.json',
        sha256: sha256File(bomPath),
        componentCount: components.length,
      },
      dependencyAudit: {
        path: 'dependency-audit.json',
        sha256: sha256File(auditPath),
        vulnerabilities: vulnerabilityCounts,
      },
      sourceFiles: { path: 'source-files.sha256', sha256: sha256File(sourcePath) },
      lockfile: {
        path: 'pnpm-lock.yaml',
        sha256: sha256File(resolve(repositoryRoot, 'pnpm-lock.yaml')),
      },
    },
    ci: process.env.GITHUB_RUN_ID
      ? {
          provider: 'github-actions',
          runId: process.env.GITHUB_RUN_ID,
          runAttempt: process.env.GITHUB_RUN_ATTEMPT,
          workflow: process.env.GITHUB_WORKFLOW,
        }
      : { provider: 'local', qualityResultNotAttested: true },
    productionReadiness: {
      ready: false,
      reason:
        'Repository evidence does not prove real WorkBuddy, managed MySQL, model, TLS, staging, signing, or rollback readiness.',
    },
  };
  const manifestPath = join(outputDirectory, 'release-manifest.json');
  writeJson(manifestPath, manifest);

  const checksums = [
    'bom.cdx.json',
    'dependency-audit.json',
    'release-manifest.json',
    'source-files.sha256',
  ]
    .map((name) => `${sha256File(join(outputDirectory, name))}  ${name}`)
    .join('\n');
  writeFileSync(join(outputDirectory, 'evidence.sha256'), `${checksums}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  log(
    `[gate] wrote repository evidence to ${relative(repositoryRoot, outputDirectory) || outputDirectory}`,
  );
  log('[gate] evidence is not a production-ready attestation');
};

const verifyEvidenceDirectory = ({ allowDirty, expectedVersion, path }) => {
  const directory = resolve(repositoryRoot, path);
  const checksumLines = readFileSync(join(directory, 'evidence.sha256'), 'utf8')
    .trim()
    .split(/\r?\n/u);
  const expectedNames = new Set([
    'bom.cdx.json',
    'dependency-audit.json',
    'release-manifest.json',
    'source-files.sha256',
  ]);
  for (const line of checksumLines) {
    const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/u);
    if (match === null || !expectedNames.has(match[2]))
      fail(`Invalid evidence checksum line: ${line}`);
    const actual = sha256File(join(directory, match[2]));
    if (actual !== match[1]) fail(`Evidence checksum mismatch: ${match[2]}`);
    expectedNames.delete(match[2]);
  }
  if (expectedNames.size > 0) fail(`Evidence checksums missing: ${[...expectedNames].join(', ')}`);

  const manifest = JSON.parse(readFileSync(join(directory, 'release-manifest.json'), 'utf8'));
  const version = expectedVersion ?? readJson('package.json').version;
  if (manifest.releaseVersion !== version) fail('Evidence release version mismatch.');
  if (manifest.git?.dirty === true && !allowDirty)
    fail('Dirty-worktree evidence is not releasable.');
  if (manifest.git?.commit !== git(['rev-parse', 'HEAD']).stdout.trim()) {
    fail('Evidence commit does not match the checkout.');
  }
  if (manifest.evidence?.sbom?.sha256 !== sha256File(join(directory, 'bom.cdx.json'))) {
    fail('Manifest SBOM hash mismatch.');
  }
  if (
    manifest.evidence?.dependencyAudit?.sha256 !==
    sha256File(join(directory, 'dependency-audit.json'))
  ) {
    fail('Manifest dependency-audit hash mismatch.');
  }
  if (
    manifest.evidence?.sourceFiles?.sha256 !== sha256File(join(directory, 'source-files.sha256'))
  ) {
    fail('Manifest source-file hash mismatch.');
  }
  if (
    manifest.evidence?.lockfile?.sha256 !== sha256File(resolve(repositoryRoot, 'pnpm-lock.yaml'))
  ) {
    fail('Manifest lockfile hash does not match the checkout.');
  }
  const bom = JSON.parse(readFileSync(join(directory, 'bom.cdx.json'), 'utf8'));
  if (
    bom.bomFormat !== 'CycloneDX' ||
    bom.specVersion !== '1.6' ||
    !Array.isArray(bom.components) ||
    bom.components.length === 0
  ) {
    fail('SBOM is not a non-empty CycloneDX 1.6 document.');
  }
  if (bom.components.length !== manifest.evidence.sbom.componentCount) {
    fail('SBOM component count does not match the manifest.');
  }

  const sourceLines = readFileSync(join(directory, 'source-files.sha256'), 'utf8')
    .trim()
    .split(/\r?\n/u);
  const remainingTrackedFiles = new Set(trackedFiles());
  for (const line of sourceLines) {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/u);
    if (match === null || !remainingTrackedFiles.has(match[2])) {
      fail(`Invalid or unexpected source checksum line: ${line}`);
    }
    if (sha256File(resolve(repositoryRoot, match[2])) !== match[1]) {
      fail(`Source checksum mismatch: ${match[2]}`);
    }
    remainingTrackedFiles.delete(match[2]);
  }
  if (remainingTrackedFiles.size > 0) {
    fail(
      `Source checksum manifest is missing tracked files: ${[...remainingTrackedFiles].join(', ')}`,
    );
  }
  log(`[gate] evidence verified for v${version}`);
};

const getPath = (value, path) =>
  path
    .split('.')
    .reduce(
      (current, key) => (current === null || current === undefined ? undefined : current[key]),
      value,
    );

const assertNoSensitiveEvidenceFields = (value, path = '$') => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveEvidenceFields(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const forbidden = new Set([
    'accesstoken',
    'authorization',
    'clientsecret',
    'connectionstring',
    'cookie',
    'password',
    'presignedurl',
    'privatekey',
    'refreshtoken',
    'secret',
  ]);
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key.toLowerCase().replaceAll(/[_-]/gu, ''))) {
      fail(`Production evidence contains a forbidden sensitive field: ${path}.${key}`);
    }
    assertNoSensitiveEvidenceFields(child, `${path}.${key}`);
  }
};

const assertProductionEvidence = (path, expectedVersion) => {
  assertStaticPolicy(expectedVersion);
  const absolutePath = resolve(repositoryRoot, path);
  const evidence = JSON.parse(readFileSync(absolutePath, 'utf8'));
  assertNoSensitiveEvidenceFields(evidence);
  const version = expectedVersion ?? readJson('package.json').version;
  if (evidence.releaseVersion !== version)
    fail('Production evidence releaseVersion does not match.');
  if (!/^[0-9a-f]{40}$/u.test(evidence.gitCommit ?? '') || evidence.gitCommit === '0'.repeat(40))
    fail('Production evidence gitCommit is invalid.');
  const requiredTruePaths = [
    'repositoryEvidence.cleanCommit',
    'repositoryEvidence.fullQualityPassed',
    'repositoryEvidence.secretScanPassed',
    'repositoryEvidence.highCriticalAuditPassed',
    'repositoryEvidence.sbomVerified',
    'repositoryEvidence.provenanceVerified',
    'staging.sameArtifactDigests',
    'staging.coreE2ePassed',
    'staging.tenantIsolationPassed',
    'workBuddy.thirdPartyAppApproved',
    'workBuddy.connectorApproved',
    'workBuddy.realClientOauthPassed',
    'workBuddy.tokenBoundaryPassed',
    'managedMySql.provisioned',
    'managedMySql.privateNetworkVerified',
    'managedMySql.tlsVerified',
    'managedMySql.backupRestoreDrillPassed',
    'model.formalProviderConfigured',
    'model.realGenerationSmokePassed',
    'model.mockFallbackDisabled',
    'tls.validCertificateInstalled',
    'tls.httpsProbePassed',
    'tls.renewalTestPassed',
    'rollback.previousArtifactsAvailable',
    'rollback.applicationRollbackDrillPassed',
    'rollback.databaseCompatibilityVerified',
    'rollback.postRollbackSmokePassed',
    'observability.alertDeliveryPassed',
    'approval.approved',
    'productionBusinessReadiness',
  ];
  const missing = requiredTruePaths.filter(
    (requiredPath) => getPath(evidence, requiredPath) !== true,
  );
  if (missing.length > 0) fail(`Production business readiness is blocked:\n${missing.join('\n')}`);

  for (const hashPath of [
    'repositoryEvidence.releaseManifestSha256',
    'repositoryEvidence.sbomSha256',
  ]) {
    const hash = getPath(evidence, hashPath);
    if (!/^sha256:[0-9a-f]{64}$/u.test(hash ?? '') || hash === `sha256:${'0'.repeat(64)}`) {
      fail(`Production evidence hash is invalid: ${hashPath}`);
    }
  }

  const expectedArtifacts = new Set(['api', 'worker', 'merchant-web', 'consumer-h5', 'ops-web']);
  for (const artifact of evidence.signedArtifacts ?? []) {
    if (!expectedArtifacts.has(artifact.name)) continue;
    if (
      !/^sha256:[0-9a-f]{64}$/u.test(artifact.digest ?? '') ||
      artifact.digest === `sha256:${'0'.repeat(64)}`
    ) {
      fail(`Invalid digest for signed artifact ${artifact.name}.`);
    }
    if (artifact.signatureVerified !== true || artifact.provenanceVerified !== true) {
      fail(`Signature/provenance not verified for ${artifact.name}.`);
    }
    expectedArtifacts.delete(artifact.name);
  }
  if (expectedArtifacts.size > 0) {
    fail(`Missing signed production artifacts: ${[...expectedArtifacts].join(', ')}`);
  }
  if (
    typeof evidence.approval.changeTicket !== 'string' ||
    evidence.approval.changeTicket.trim() === ''
  ) {
    fail('Production approval requires a non-empty changeTicket.');
  }
  if (!Array.isArray(evidence.approval.approvers) || evidence.approval.approvers.length < 2) {
    fail('Production approval requires at least two approvers.');
  }
  if (new Set(evidence.approval.approvers).size !== evidence.approval.approvers.length) {
    fail('Production approvers must be distinct.');
  }
  for (const referencePath of [
    'staging.evidenceReference',
    'workBuddy.evidenceReference',
    'managedMySql.evidenceReference',
    'model.evidenceReference',
    'tls.evidenceReference',
    'rollback.exerciseId',
    'rollback.evidenceReference',
    'observability.evidenceReference',
  ]) {
    const reference = getPath(evidence, referencePath);
    if (
      typeof reference !== 'string' ||
      reference.trim().length === 0 ||
      reference.startsWith('REPLACE_')
    ) {
      fail(`Production evidence reference is missing: ${referencePath}`);
    }
  }
  log('[gate] production business readiness evidence passed');
};

const runRepositoryGate = ({ allowDirty, expectedVersion }) => {
  assertStaticPolicy(expectedVersion);
  const composeProgram = standaloneComposeCommand || 'docker';
  const composeArguments = (args) =>
    standaloneComposeCommand === undefined || standaloneComposeCommand.length === 0
      ? ['compose', ...args]
      : args;
  const commands = [
    [pnpmCommand, ['audit', '--audit-level=high']],
    [
      composeProgram,
      composeArguments([
        '--env-file',
        '.env.example',
        '--file',
        'infra/compose/docker-compose.dev.yml',
        'config',
        '--quiet',
      ]),
    ],
    [
      composeProgram,
      composeArguments([
        '--env-file',
        'infra/compose/release.env.example',
        '--file',
        'infra/compose/docker-compose.release.yml',
        'config',
        '--quiet',
      ]),
    ],
    [pnpmCommand, ['format:check']],
    [pnpmCommand, ['lint']],
    [pnpmCommand, ['typecheck']],
    [pnpmCommand, ['test']],
    [pnpmCommand, ['build']],
  ];
  for (const [program, args] of commands) {
    log(`[gate] ${program} ${args.join(' ')}`);
    run(program, args);
  }
  const shellScripts = trackedFiles().filter((path) => path.endsWith('.sh'));
  if (shellScripts.length > 0) {
    if (standaloneShellcheckCommand !== undefined && standaloneShellcheckCommand.length > 0) {
      run(standaloneShellcheckCommand, ['--severity=error', '--shell=bash', ...shellScripts]);
    } else {
      run('bash', ['-n', ...shellScripts]);
    }
  }
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'h5cs-release-evidence-'));
  try {
    generateEvidence({
      allowDirty,
      expectedVersion,
      output: temporaryDirectory,
    });
    verifyEvidenceDirectory({
      allowDirty,
      expectedVersion,
      path: temporaryDirectory,
    });
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
  log('[gate] repository standard release gate passed');
};

const usage = () => {
  process.stdout.write(
    `Usage:\n  node scripts/quality/release-gate.mjs static [--version 0.1.0]\n  node scripts/quality/release-gate.mjs repository [--version 0.1.0] [--allow-dirty]\n  node scripts/quality/release-gate.mjs evidence --output <directory> [--version 0.1.0] [--allow-dirty]\n  node scripts/quality/release-gate.mjs verify --evidence <directory> [--version 0.1.0] [--allow-dirty]\n  node scripts/quality/release-gate.mjs production --evidence <json> [--version 0.1.0]\n`,
  );
};

const main = () => {
  const args = parseArguments(process.argv.slice(2));
  const command = args._[0];
  const expectedVersion = typeof args.version === 'string' ? args.version : undefined;
  if (command === 'static') {
    assertStaticPolicy(expectedVersion);
    return;
  }
  if (command === 'repository') {
    runRepositoryGate({ allowDirty: args['allow-dirty'] === true, expectedVersion });
    return;
  }
  if (command === 'evidence') {
    if (typeof args.output !== 'string') fail('evidence requires --output <directory>.');
    generateEvidence({
      allowDirty: args['allow-dirty'] === true,
      expectedVersion,
      output: args.output,
    });
    return;
  }
  if (command === 'verify') {
    if (typeof args.evidence !== 'string') fail('verify requires --evidence <directory>.');
    verifyEvidenceDirectory({
      allowDirty: args['allow-dirty'] === true,
      expectedVersion,
      path: args.evidence,
    });
    return;
  }
  if (command === 'production') {
    if (typeof args.evidence !== 'string') fail('production requires --evidence <json>.');
    assertProductionEvidence(args.evidence, expectedVersion);
    return;
  }
  usage();
  process.exitCode = 64;
};

try {
  main();
} catch (error) {
  if (error instanceof GateError) {
    process.stderr.write(`[gate] FAIL: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
