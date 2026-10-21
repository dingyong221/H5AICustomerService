import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('./verify-ci-mysql-restore.sh', import.meta.url), 'utf8');
const command = /if docker exec "\$restore_container" sh -ec \\\r?\n\s*'([^']+)'/u.exec(
  source,
)?.[1];
const guard = /^read -r ([a-z][a-z0-9_]*) < \/proc\/1\/comm; test "\$\1" = mysqld; /u;

test('readiness requires final PID1 mysqld before the authenticated socket SQL probe', () => {
  assert.ok(command, 'the real restore readiness command must be found');
  assert.match(command, guard);
  assert.match(
    command,
    /MYSQL_PWD="\$MYSQL_ROOT_PASSWORD"; export MYSQL_PWD; exec mysql --protocol=socket -uroot --batch --skip-column-names --execute="SELECT 1"$/u,
  );
  assert.ok(command.indexOf('/proc/1/comm') < command.indexOf('exec mysql'));
});

test('mock bootstrap → formal-not-ready → formal-ready does not accept temporary SELECT1', () => {
  assert.match(command, guard); // Couple the mock to the actual shell guard.
  const sequence = [
    { pid1: 'docker-entrypoi', sql: true },
    { pid1: 'mysqld', sql: false },
    { pid1: 'mysqld', sql: true },
  ];
  const sqlCalls = [],
    outcomes = sequence.map((value, index) => {
      if (value.pid1 !== 'mysqld') return false;
      sqlCalls.push(index);
      return value.sql;
    });
  assert.deepEqual(outcomes, [false, false, true]);
  assert.deepEqual(sqlCalls, [1, 2]);
});

test('90-attempt bound, network-none tmpfs and exact nonempty restore comparison remain unchanged', () => {
  assert.match(source, /for \(\(attempt=0; attempt<90; attempt\+\+\)\); do/u);
  assert.match(source, /\n  sleep 1\ndone\nif \[\[ \$ready -ne 1 \]\]/u);
  assert.match(source, /--network none \\\r?\n  --tmpfs \/var\/lib\/mysql:rw,size=1g,mode=0700/u);
  assert.match(source, /--skip-networking --skip-log-bin --mysqlx=OFF/u);
  assert.match(source, /if \[\[ \$after != "\$before" \]\]/u);
  assert.match(source, /message_count -lt 2/u);
  assert.doesNotMatch(
    source,
    /docker (?:system|volume|image) prune|--network host|--publish|-p 3306/u,
  );
});

test(
  'actual POSIX shell blocks bootstrap SQL, retries unready formal daemon then succeeds',
  { skip: process.platform === 'win32' },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'h5cs-restore-probe-'));
    try {
      const comm = join(directory, 'pid1-comm'),
        log = join(directory, 'mysql-called');
      writeFileSync(
        join(directory, 'mysql'),
        '#!/bin/sh\nprintf called >> "$H5CS_PROBE_LOG"\ntest "$H5CS_PROBE_SQL_READY" = yes\n',
        { mode: 0o700 },
      );
      const probe = command.replace('/proc/1/comm', `"${comm}"`);
      const run = (pid1, sql) => {
        writeFileSync(comm, pid1 + '\n');
        return spawnSync('sh', ['-ec', probe], {
          encoding: 'utf8',
          timeout: 10000,
          env: {
            ...process.env,
            PATH: directory + delimiter + process.env['PATH'],
            MYSQL_ROOT_PASSWORD: 'synthetic-ci-only',
            H5CS_PROBE_LOG: log,
            H5CS_PROBE_SQL_READY: sql ? 'yes' : 'no',
          },
        });
      };
      assert.equal(run('docker-entrypoi', true).status, 1);
      assert.equal(existsSync(log), false, 'bootstrap must not even invoke mysql');
      assert.equal(run('mysqld', false).status, 1);
      assert.equal(readFileSync(log, 'utf8'), 'called');
      assert.equal(run('mysqld', true).status, 0);
      assert.equal(readFileSync(log, 'utf8'), 'calledcalled');
    } finally {
      assert.equal(
        resolve(directory).startsWith(resolve(join(tmpdir(), 'h5cs-restore-probe-'))),
        true,
      );
      rmSync(directory, { recursive: true });
    }
  },
);
