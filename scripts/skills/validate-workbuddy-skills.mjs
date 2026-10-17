import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writingFields } from '../../packages/contracts/src/writing.ts';

export const standaloneRoot = fileURLToPath(
  new URL('../../integrations/workbuddy/standalone-skills/', import.meta.url),
);
export const skillNames = [
  'h5cs-material-writer',
  'h5cs-faq-builder',
  'h5cs-release-check',
  'h5cs-web-guide',
];
const keys = new Set([
  'name',
  'display_name',
  'display_name_en',
  'description',
  'description_zh',
  'description_en',
  'category',
  'version',
  'author',
  'disable-model-invocation',
  'user-invocable',
]);

// The maintained packages intentionally use only flat scalar YAML frontmatter.
export function readMetadata(text) {
  const match = /^---\r?\n([\s\S]+?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) throw new Error('Missing frontmatter');
  const metadata = Object.create(null);
  for (const line of match[1].split(/\r?\n/u)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const entry = /^([a-z][a-z_-]*):\s*(.+)$/u.exec(line);
    if (!entry || !keys.has(entry[1]) || Object.hasOwn(metadata, entry[1]))
      throw new Error('Unsupported or duplicate metadata');
    const raw = entry[2].trim();
    if (/^[>|\[\{&*!]/u.test(raw)) throw new Error('Only scalar metadata is supported');
    metadata[entry[1]] =
      raw === 'true'
        ? true
        : raw === 'false'
          ? false
          : raw.startsWith('"')
            ? JSON.parse(raw)
            : raw.startsWith("'") && raw.endsWith("'")
              ? raw.slice(1, -1).replace(/''/gu, "'")
              : raw;
  }
  return metadata;
}

function assertMetadata(metadata, name) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || name.length > 64 || metadata.name !== name)
    throw new Error('Invalid skill name');
  for (const key of ['description', 'description_zh', 'description_en', 'version', 'author'])
    if (typeof metadata[key] !== 'string' || !metadata[key].trim())
      throw new Error(`Missing ${key}`);
  if (metadata.description.length > 1024 || !/^\d+\.\d+\.\d+$/u.test(metadata.version))
    throw new Error('Invalid metadata bounds');
  if (metadata['disable-model-invocation'] !== false || metadata['user-invocable'] !== true)
    throw new Error('Unexpected invocation policy');
}

export async function validateSkill(folder) {
  const root = await realpath(folder);
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory)) {
      const path = resolve(directory, entry);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('Symlink in package');
      const packagePath = relative(root, path).replaceAll('\\', '/');
      if (info.isDirectory()) {
        if (packagePath !== 'references') throw new Error('Unexpected standalone directory');
        await walk(path);
      } else {
        if (
          !info.isFile() ||
          !/^(?:SKILL\.md|references\/[a-z0-9-]+\.md)$/u.test(packagePath) ||
          info.size > 100_000
        )
          throw new Error('Unexpected file or file size');
        const content = await readFile(path, 'utf8');
        if (
          /\[TODO:|-----BEGIN .*PRIVATE KEY-----|\bsk-[A-Za-z0-9]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}/u.test(
            content,
          )
        )
          throw new Error('Unfinished or sensitive content');
        files.push({
          path: packagePath,
          sha256: createHash('sha256').update(content).digest('hex'),
        });
      }
    }
  }
  await walk(root);
  const text = await readFile(resolve(root, 'SKILL.md'), 'utf8');
  const metadata = readMetadata(text);
  assertMetadata(metadata, basename(root));
  const references = [...text.matchAll(/@references\/([a-z0-9-]+\.md)/gu)].map(
    (match) => `references/${match[1]}`,
  );
  for (const reference of references)
    if (!files.some((file) => file.path === reference)) throw new Error('Missing skill reference');
  if (/@references\/[^\s]+/u.test(text) && references.length === 0)
    throw new Error('Invalid reference path');
  const unused = files.filter(
    (file) => file.path !== 'SKILL.md' && !references.includes(file.path),
  );
  if (unused.length) throw new Error('Unrouted supporting resources');
  return {
    name: metadata.name,
    version: metadata.version,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export async function validateAll(root = standaloneRoot) {
  const listed = (await readdir(root)).sort();
  if (JSON.stringify(listed) !== JSON.stringify([...skillNames].sort()))
    throw new Error('Unexpected skill set');
  const skills = [];
  for (const name of skillNames) skills.push(await validateSkill(resolve(root, name)));
  const fields = await readFile(resolve(root, 'h5cs-material-writer/references/fields.md'), 'utf8');
  for (const [key, spec] of Object.entries(writingFields)) {
    const row = new RegExp(
      `\\|\\s*${key}\\s*\\|\\s*${spec.label}\\s*\\|\\s*${spec.maximum}\\s*\\|`,
      'u',
    );
    if (!row.test(fields)) throw new Error(`Field contract drift: ${key}`);
  }
  return {
    platform: 'workbuddy',
    status: 'source-validation-passed',
    clientImportVerified: false,
    marketplaceApproved: false,
    skills,
  };
}

if (
  process.argv[1] &&
  isAbsolute(resolve(process.argv[1])) &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(JSON.stringify(await validateAll(), null, 2));
  } catch (error) {
    console.error(`WorkBuddy skill validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
