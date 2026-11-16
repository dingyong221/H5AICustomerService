import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
export const stage2Baseline = '5b6d5ead34ec5c061e7b22d3a159c26f0c99a451';
export async function prepareStage2Baseline(runRoot) {
  const worktree = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const gitFile = (p) =>
    execFileSync('git', ['show', `${stage2Baseline}:${p}`], {
      cwd: worktree,
      encoding: 'utf8',
      windowsHide: true,
    });
  const legacySource = gitFile('packages/database/src/public-session-repository.ts');
  const legacyModule = join(runRoot, 'baseline-public-reader.mjs');
  const js = ts.transpileModule(legacySource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
  }).outputText;
  await writeFile(
    legacyModule,
    js.replaceAll(
      "'@h5cs/domain'",
      JSON.stringify(pathToFileURL(join(worktree, 'packages/domain/dist/index.js')).href),
    ),
  );
  await writeFile(join(runRoot, 'baseline-public-reader.ts'), legacySource);
  const baselineMigrations = join(runRoot, 'baseline-migrations');
  await mkdir(join(baselineMigrations, 'meta'), { recursive: true });
  const journal = JSON.parse(gitFile('packages/database/migrations/meta/_journal.json'));
  await writeFile(join(baselineMigrations, 'meta/_journal.json'), JSON.stringify(journal));
  for (const entry of journal.entries)
    await writeFile(
      join(baselineMigrations, `${entry.tag}.sql`),
      gitFile(`packages/database/migrations/${entry.tag}.sql`),
    );
  await writeFile(
    join(runRoot, 'baseline.json'),
    JSON.stringify(
      {
        baseline: stage2Baseline,
        sourceSha256: createHash('sha256').update(legacySource).digest('hex'),
        baselineMigrationCount: journal.entries.length,
        transformation:
          'TypeScript transpilation; domain import binds current additive domain exports',
      },
      null,
      2,
    ),
  );
  return { legacyModule, baselineMigrations };
}
