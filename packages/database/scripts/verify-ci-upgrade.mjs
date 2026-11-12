import { createHash, randomBytes } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationInventory } from './migrate-managed.mjs';

const sourceFolder = fileURLToPath(new URL('../migrations/', import.meta.url));
const migrationTable = '__drizzle_migrations';
const tempPrefix = 'h5cs-ci-upgrade-';
const expectedDatabase = 'h5cs_integration_ci';
const expectedUser = 'h5cs_ci';
const expectedBaselineCount = 12;
const expectedFullCount = 19;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export class UpgradeProbeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpgradeProbeError';
  }
}

export function safeProbeFailure(error, phase) {
  const previousPhase = error instanceof UpgradeProbeError ? error.phase : undefined;
  const candidatePhase = previousPhase ?? phase;
  const safePhase =
    typeof candidatePhase === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(candidatePhase)
      ? candidatePhase
      : 'unknown';
  let driverCode;
  let driverErrno;
  let current = error;
  // Drizzle wraps driver errors in `cause`. Never include message, SQL, stack,
  // connection options or the cause object in diagnostics.
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if (
      driverCode === undefined &&
      typeof current.code === 'string' &&
      /^(?:ER_[A-Z0-9_]{1,60}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|EPIPE)$/u.test(
        current.code,
      )
    )
      driverCode = current.code;
    if (
      driverErrno === undefined &&
      Number.isSafeInteger(current.errno) &&
      Math.abs(current.errno) <= 65_535
    )
      driverErrno = current.errno;
    current = current.cause;
  }
  const diagnostic = new UpgradeProbeError(
    `CI upgrade probe failed in phase=${safePhase}; driver_code=${driverCode ?? 'unavailable'} driver_errno=${driverErrno ?? 'unavailable'}; database details omitted`,
  );
  diagnostic.phase = safePhase;
  diagnostic.code = driverCode;
  diagnostic.errno = driverErrno;
  return diagnostic;
}

export async function acquireMigrationLock(connection) {
  const [rows] = await connection.query(
    "SELECT GET_LOCK('h5cs_schema_migration_v1', 0) AS acquired",
  );
  const value = rows?.[0]?.acquired;
  // GET_LOCK is a BIGINT expression. mysql2's bigNumberStrings setting returns
  // even the successful value 1 as '1'; do not mistake it for lock contention.
  if (value !== 1 && value !== '1') {
    throw new UpgradeProbeError(
      value === 0 || value === '0'
        ? 'Another schema migration is active'
        : 'Migration lock acquisition did not report success',
    );
  }
  return { acquired: true, driverValueType: typeof value };
}

export function parseUpgradeArguments(args) {
  if (args.length === 1 && args[0] === '--run') return { action: 'run' };
  if (args.length === 1 && args[0] === '--check-target') return { action: 'check-target' };
  throw new UpgradeProbeError(
    'Use exactly --run or --check-target; no database or migration overrides are accepted',
  );
}

export function validateUpgradeTarget(environment = process.env) {
  if (
    environment.CI !== 'true' ||
    environment.NODE_ENV === 'production' ||
    environment.APP_ENV === 'production'
  ) {
    throw new UpgradeProbeError(
      'Upgrade probe is restricted to an explicitly non-production CI environment',
    );
  }
  const value = environment.H5CS_INTEGRATION_MYSQL_URL;
  if (
    typeof value !== 'string' ||
    value.length > 2_048 ||
    value !== value.trim() ||
    /[\r\n]/u.test(value)
  ) {
    throw new UpgradeProbeError('Dedicated CI MySQL URL is missing or invalid');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new UpgradeProbeError('Dedicated CI MySQL URL is invalid');
  }
  if (
    parsed.protocol !== 'mysql:' ||
    !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
    parsed.pathname !== `/${expectedDatabase}` ||
    parsed.username !== expectedUser ||
    !parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.port && (!/^[1-9][0-9]{0,4}$/u.test(parsed.port) || Number(parsed.port) > 65_535)) ||
    (environment.H5CS_MYSQL_DATABASE !== undefined &&
      environment.H5CS_MYSQL_DATABASE !== expectedDatabase)
  )
    throw new UpgradeProbeError(
      'Refusing a target outside the dedicated loopback CI database and account',
    );
  // The returned object intentionally omits the password and complete URL.
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    database: expectedDatabase,
    user: expectedUser,
  };
}

export async function reviewedUpgradePlan(folder = sourceFolder) {
  const journalPath = join(folder, 'meta', '_journal.json');
  const inventory = migrationInventory(folder, journalPath);
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  if (
    inventory.entries.length !== expectedFullCount ||
    journal.entries.length !== expectedFullCount ||
    !/^0012_/u.test(journal.entries[12]?.tag ?? '') ||
    journal.entries[14]?.tag !== '0014_flimsy_swarm' ||
    journal.entries[15]?.tag !== '0015_clumsy_prowler'
  ) {
    throw new UpgradeProbeError(
      'Probe requires the reviewed twelve-to-sixteen migration plan; review the probe when the plan changes',
    );
  }
  const entries = inventory.entries.map((entry, index) => {
    const source = journal.entries[index];
    if (
      !Number.isSafeInteger(source.when) ||
      source.when < 1 ||
      (index > 0 && source.when <= journal.entries[index - 1].when)
    ) {
      throw new UpgradeProbeError(
        'Migration timestamps must be strictly ordered positive integers',
      );
    }
    return { ...entry, when: String(source.when) };
  });
  return { inventory, journal, entries };
}

export function assertTemporaryTarget(parent, created) {
  const normalizedParent = resolve(parent);
  const normalized = resolve(created);
  if (
    dirname(normalized) !== normalizedParent ||
    !/^h5cs-ci-upgrade-[A-Za-z0-9]{6}$/u.test(basename(normalized))
  ) {
    throw new UpgradeProbeError(
      'Refusing cleanup outside the exact generated upgrade scratch directory',
    );
  }
  return normalized;
}

export async function baselineMigrationFolder(plan, folder = sourceFolder) {
  const parent = await realpath(tmpdir());
  const created = await mkdtemp(join(parent, tempPrefix));
  const cleanup = async () => {
    const exact = assertTemporaryTarget(parent, created);
    const stat = await lstat(exact);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (await realpath(exact)) !== exact) {
      throw new UpgradeProbeError(
        'Generated migration scratch directory changed identity; refusing cleanup',
      );
    }
    await rm(exact, { recursive: true, force: false });
  };
  try {
    await mkdir(join(created, 'meta'));
    for (const entry of plan.journal.entries.slice(0, expectedBaselineCount)) {
      await copyFile(join(folder, `${entry.tag}.sql`), join(created, `${entry.tag}.sql`));
    }
    await writeFile(
      join(created, 'meta', '_journal.json'),
      `${JSON.stringify({ ...plan.journal, entries: plan.journal.entries.slice(0, expectedBaselineCount) }, null, 2)}\n`,
      { flag: 'wx' },
    );
    const copied = migrationInventory(created, join(created, 'meta', '_journal.json'));
    if (
      JSON.stringify(copied.entries) !==
      JSON.stringify(plan.inventory.entries.slice(0, expectedBaselineCount))
    )
      throw new UpgradeProbeError('Copied baseline SQL differs from the reviewed source');
    return { folder: created, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function assertEmptyCiDatabase(connection) {
  const [selected] = await connection.query(
    'SELECT DATABASE() AS selected_database, CURRENT_USER() AS connected_account',
  );
  if (
    !Array.isArray(selected) ||
    selected.length !== 1 ||
    selected[0].selected_database !== expectedDatabase ||
    typeof selected[0].connected_account !== 'string' ||
    !selected[0].connected_account.startsWith(`${expectedUser}@`)
  ) {
    throw new UpgradeProbeError('Live connection does not match the dedicated CI database/account');
  }
  const [objects] = await connection.query(
    `SELECT 'table_or_view' AS kind, TABLE_NAME AS object_name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
     UNION ALL SELECT 'routine', ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()
     UNION ALL SELECT 'event', EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE()
     UNION ALL SELECT 'trigger', TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()`,
  );
  if (!Array.isArray(objects) || objects.length !== 0)
    throw new UpgradeProbeError(
      'CI database is not empty; no reset, deletion, seed or migration was attempted',
    );
}

export async function readMysqlVersion(connection) {
  const [rows] = await connection.query('SELECT VERSION() AS mysql_version');
  const version = rows[0]?.mysql_version;
  if (typeof version !== 'string' || !/^[0-9][0-9A-Za-z._+-]{0,127}$/u.test(version))
    throw new UpgradeProbeError('MySQL did not return an expected version identifier');
  return version;
}

const quote = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_]+$/u.test(value))
    throw new UpgradeProbeError('Unexpected SQL identifier');
  return `\`${value}\``;
};
export function normalizeStoredValue(value) {
  if (Buffer.isBuffer(value)) return { binary: value.toString('hex') };
  if (value instanceof Date) return { date: value.toISOString() };
  if (typeof value === 'bigint') return { integer: value.toString() };
  if (Array.isArray(value)) return value.map(normalizeStoredValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeStoredValue(value[key])]),
    );
  return value;
}
export function storedRowsDigest(rows) {
  const normalized = rows.map((row) => JSON.stringify(normalizeStoredValue(row))).sort();
  return sha256(JSON.stringify(normalized));
}
async function applicationTables(connection) {
  const [rows] = await connection.query(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
  );
  return rows.map((row) => row.name).filter((name) => name !== migrationTable);
}
export function assertUpgradedTableSet(tables, baselineTables) {
  const expected = [
    ...baselineTables,
    'assistant_improvement',
    'assistant_evaluation_run',
    'assistant_publication_governance',
    'merchant_assistant',
    'marketplace_allocation',
    'marketplace_campaign',
    'marketplace_claim_code',
    'marketplace_entitlement',
    'marketplace_free_claim',
    'marketplace_model_attempt',
    'marketplace_signup_throttle',
    'growth_invitation',
    'growth_touch',
    'growth_referral',
    'product_usage_actor',
    'product_usage_day',
    'product_usage_event',
    'product_usage_budget',
    'model_call_attempt',
  ];
  if (
    expected.length !== 48 ||
    new Set(expected).size !== 48 ||
    tables.length !== 48 ||
    new Set(tables).size !== 48 ||
    tables.some((table) => !expected.includes(table))
  )
    throw new UpgradeProbeError('Upgrade produced an unexpected application-table set');
}
export async function snapshotTables(connection, tables, options = {}) {
  const output = [];
  for (const table of tables) {
    const [rows] = await connection.query(`SELECT * FROM ${quote(table)}`);
    const [definition] = await connection.query(`SHOW CREATE TABLE ${quote(table)}`);
    let definitionSql = definition[0]['Create Table'];
    if (table === 'job' && options.legacyJobProjection) {
      // Only these three additive runtime columns are excluded. All pre-existing
      // values and the rest of the legacy schema remain byte-for-byte checked.
      for (const row of rows) for (const field of ['claim_generation', 'model_outcome', 'model_attempt_id']) delete row[field];
      definitionSql = definitionSql.split('\n').filter(line => !/^\s*`(?:claim_generation|model_outcome|model_attempt_id)` /u.test(line)).join('\n');
    }
    output.push({
      table,
      count: rows.length,
      contentSha256: storedRowsDigest(rows),
      schemaSha256: sha256(definitionSql),
    });
  }
  return { tables: output, sha256: sha256(JSON.stringify(output)) };
}
export async function assertMigrationHistory(connection, expected) {
  const [rows] = await connection.query(
    `SELECT id, hash, created_at FROM ${quote(migrationTable)} ORDER BY id`,
  );
  if (rows.length !== expected.length)
    throw new UpgradeProbeError('Migration history count differs from the reviewed plan');
  for (let index = 0; index < expected.length; index++) {
    if (
      String(rows[index].id) !== String(index + 1) ||
      rows[index].hash !== expected[index].sha256 ||
      String(rows[index].created_at) !== expected[index].when
    ) {
      throw new UpgradeProbeError(
        'A migration history hash, timestamp or order differs from the real reviewed SQL',
      );
    }
  }
  return rows.map((row, index) => ({
    id: String(row.id),
    tag: expected[index].tag,
    sha256: row.hash,
    when: String(row.created_at),
  }));
}

export async function seedBaselineData(connection) {
  const ids = Object.fromEntries(
    [
      'merchant',
      'otherMerchant',
      'owner',
      'assistant',
      'sameMerchantAssistant',
      'otherAssistant',
      'source',
      'knowledge',
      'release',
      'session',
      'visitor',
      'reply',
      'turn',
    ].map((name) => [name, randomBytes(16)]),
  );
  const timestamp = '2026-10-17 01:02:03.123456';
  const releasedFacts = {
    industry: '电商零售',
    businessScope: '合成保温杯咨询，非真实交易',
    materialsSummary: '测试保温杯A，500ml。\n商品说明保留中文与emoji：☕。',
    pricingSummary: 'A款99元；新疆运费需联系商家确认。',
    promotionSummary: '无已确认优惠，不承诺叠加。',
    welcomeMessage: '您好，我是AI客服。',
    insufficientInfoMessage: '此项信息待核实，请联系原购买渠道。',
  };
  const pendingDraft = { ...releasedFacts, pricingSummary: '未发布修订：A款129元，待商家确认。' };
  const publicSlug = `a-${randomBytes(18).toString('hex')}`;
  const releaseConfig = {
    draftRevision: 1,
    knowledgeRevisionId: ids.knowledge.toString('hex'),
    displayName: '旧版合成客服',
    ...releasedFacts,
  };
  const factsHash = Buffer.from(sha256(JSON.stringify(releasedFacts)), 'hex');
  await connection.beginTransaction();
  try {
    await connection.execute(
      "INSERT INTO merchant (id, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?), (?, ?, 'active', ?, ?)",
      [
        ids.merchant,
        '升级探针合成商家A',
        timestamp,
        timestamp,
        ids.otherMerchant,
        '升级探针合成商家B',
        timestamp,
        timestamp,
      ],
    );
    await connection.execute(
      "INSERT INTO merchant_user (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)",
      [ids.owner, timestamp, timestamp],
    );
    await connection.execute(
      "INSERT INTO merchant_membership (merchant_id, merchant_user_id, role, status, created_at, updated_at) VALUES (?, ?, 'owner', 'active', ?, ?), (?, ?, 'owner', 'active', ?, ?)",
      [
        ids.merchant,
        ids.owner,
        timestamp,
        timestamp,
        ids.otherMerchant,
        ids.owner,
        timestamp,
        timestamp,
      ],
    );
    for (const [assistant, merchant, name] of [
      [ids.assistant, ids.merchant, '旧版合成客服'],
      [ids.sameMerchantAssistant, ids.merchant, '同商家其他客服'],
      [ids.otherAssistant, ids.otherMerchant, '其他商家客服'],
    ]) {
      const slug =
        assistant === ids.assistant ? publicSlug : `a-${randomBytes(18).toString('hex')}`;
      await connection.execute(
        "INSERT INTO assistant (id, merchant_id, display_name, public_slug, public_slug_digest, status, draft_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft_only', ?, ?, ?)",
        [
          assistant,
          merchant,
          name,
          slug,
          Buffer.from(sha256(slug), 'hex'),
          assistant === ids.assistant ? 2 : 1,
          timestamp,
          timestamp,
        ],
      );
      await connection.execute(
        'INSERT INTO assistant_draft (assistant_id, merchant_id, revision, config, validation, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          assistant,
          merchant,
          assistant === ids.assistant ? 2 : 1,
          JSON.stringify(assistant === ids.assistant ? pendingDraft : releasedFacts),
          JSON.stringify({ publishable: false, reason: 'knowledge_not_verified' }),
          ids.owner,
          timestamp,
        ],
      );
    }
    await connection.execute(
      "INSERT INTO knowledge_source (id, merchant_id, assistant_id, type, title, status, current_revision_no, created_at, updated_at) VALUES (?, ?, ?, 'merchant_confirmed_text', ?, 'active', 1, ?, ?)",
      [ids.source, ids.merchant, ids.assistant, '旧版已确认商品资料', timestamp, timestamp],
    );
    await connection.execute(
      "INSERT INTO knowledge_revision (id, merchant_id, assistant_id, source_id, revision_no, status, content_hash, source_metadata, parser_version, created_at, processed_at) VALUES (?, ?, ?, ?, 1, 'ready', ?, ?, 'merchant-confirmed-v1', ?, ?)",
      [
        ids.knowledge,
        ids.merchant,
        ids.assistant,
        ids.source,
        factsHash,
        JSON.stringify({ kind: 'merchant_confirmed_text', draftRevision: 1, facts: releasedFacts }),
        timestamp,
        timestamp,
      ],
    );
    await connection.execute(
      "INSERT INTO assistant_release (id, merchant_id, assistant_id, release_no, draft_revision, status, config_snapshot, prompt_template_version, retrieval_policy_version, model_policy_version, created_by, created_at, activated_at) VALUES (?, ?, ?, 1, 1, 'active', ?, 'upgrade-baseline-v1', 'confirmed-text-v1', 'synthetic-no-model-v1', ?, ?, ?)",
      [
        ids.release,
        ids.merchant,
        ids.assistant,
        JSON.stringify(releaseConfig),
        ids.owner,
        timestamp,
        timestamp,
      ],
    );
    await connection.execute(
      'INSERT INTO assistant_active_release (merchant_id, assistant_id, release_id, activated_at) VALUES (?, ?, ?, ?)',
      [ids.merchant, ids.assistant, ids.release, timestamp],
    );
    await connection.execute(
      "UPDATE assistant SET active_release_id = ?, status = 'active' WHERE merchant_id = ? AND id = ?",
      [ids.release, ids.merchant, ids.assistant],
    );
    await connection.execute(
      "INSERT INTO conversation_session (id, merchant_id, assistant_id, release_id, visitor_credential_id, status, follow_up_status, next_sequence, last_activity_at, expires_at, ended_at, ended_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'ended', 'in_progress', 3, ?, ?, ?, 'visitor_ended', ?, ?)",
      [
        ids.session,
        ids.merchant,
        ids.assistant,
        ids.release,
        randomBytes(16),
        timestamp,
        '2026-10-17 01:32:03.123456',
        timestamp,
        timestamp,
        timestamp,
      ],
    );
    for (const [message, sequence, role, content, clientId] of [
      [
        ids.visitor,
        1,
        'visitor',
        '这款保温杯多少钱？寄新疆包邮吗？',
        `message_${randomBytes(16).toString('hex')}`,
      ],
      [
        ids.reply,
        2,
        'assistant',
        '合成旧版答复：A款99元，新疆运费需联系商家核实，不能承诺包邮。',
        null,
      ],
    ]) {
      await connection.execute(
        "INSERT INTO message (id, merchant_id, assistant_id, session_id, turn_id, seq_no, role, state, client_request_id, content, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)",
        [
          message,
          ids.merchant,
          ids.assistant,
          ids.session,
          ids.turn,
          sequence,
          role,
          clientId,
          content,
          timestamp,
          timestamp,
        ],
      );
    }
    await connection.execute(
      "INSERT INTO job (id, merchant_id, type, dedup_key, payload, state, attempt, run_after, completed_at, created_at, updated_at) VALUES (?, ?, 'conversation.turn', ?, ?, 'completed', 1, ?, ?, ?, ?)",
      [
        randomBytes(16),
        ids.merchant,
        randomBytes(32),
        JSON.stringify({
          syntheticUpgradeFixture: true,
          sessionId: ids.session.toString('hex'),
          turnId: ids.turn.toString('hex'),
        }),
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      ],
    );
    await connection.execute(
      "INSERT INTO audit_log (id, merchant_id, actor_type, actor_id, action, target_type, target_id, result, request_id, metadata, occurred_at, created_at) VALUES (?, ?, 'merchant_user', ?, 'ci.upgrade.fixture.seed', 'assistant', ?, 'success', ?, ?, ?, ?)",
      [
        randomBytes(16),
        ids.merchant,
        ids.owner.toString('hex'),
        ids.assistant.toString('hex'),
        `upgrade_${randomBytes(16).toString('hex')}`,
        JSON.stringify({ synthetic: true, noModelCalled: true }),
        timestamp,
        timestamp,
      ],
    );
    await connection.commit();
    return ids;
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

async function assertConstraintRejected(action, expectedCode, label) {
  try {
    await action();
  } catch (error) {
    if (error?.code === expectedCode) return label;
    throw safeProbeFailure(error, `constraint_${label}`);
  }
  throw new UpgradeProbeError(`${label} unexpectedly accepted invalid scoped data`);
}
async function assertNewTableConstraints(connection, ids) {
  const [engines] = await connection.query(
    "SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('assistant_improvement', 'assistant_evaluation_run') ORDER BY TABLE_NAME",
  );
  if (engines.length !== 2 || engines.some((row) => row.engine !== 'InnoDB'))
    throw new UpgradeProbeError('Both new tables must use InnoDB');
  const [keys] = await connection.query(
    "SELECT CONSTRAINT_NAME AS name, TABLE_NAME AS child_table, COLUMN_NAME AS child_column, REFERENCED_TABLE_NAME AS parent_table, REFERENCED_COLUMN_NAME AS parent_column, ORDINAL_POSITION AS ordinal FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME IN ('assistant_improvement', 'assistant_evaluation_run') AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION",
  );
  const expected = {
    fk_evaluation_improvement: [
      'assistant_evaluation_run',
      'assistant_improvement',
      ['merchant_id', 'assistant_id', 'improvement_id'],
      ['merchant_id', 'assistant_id', 'id'],
    ],
    fk_improvement_assistant: [
      'assistant_improvement',
      'assistant',
      ['merchant_id', 'assistant_id'],
      ['merchant_id', 'id'],
    ],
    fk_improvement_session: [
      'assistant_improvement',
      'conversation_session',
      ['merchant_id', 'assistant_id', 'source_session_id'],
      ['merchant_id', 'assistant_id', 'id'],
    ],
    fk_improvement_message: [
      'assistant_improvement',
      'message',
      ['merchant_id', 'assistant_id', 'source_message_id'],
      ['merchant_id', 'assistant_id', 'id'],
    ],
    fk_improvement_source_release: [
      'assistant_improvement',
      'assistant_release',
      ['merchant_id', 'assistant_id', 'source_release_id'],
      ['merchant_id', 'assistant_id', 'id'],
    ],
    fk_improvement_published_release: [
      'assistant_improvement',
      'assistant_release',
      ['merchant_id', 'assistant_id', 'published_release_id'],
      ['merchant_id', 'assistant_id', 'id'],
    ],
  };
  if (new Set(keys.map((row) => row.name)).size !== Object.keys(expected).length)
    throw new UpgradeProbeError('New-table foreign-key set differs from the reviewed plan');
  for (const [name, [child, parent, childColumns, parentColumns]] of Object.entries(expected)) {
    const columns = keys.filter((row) => row.name === name);
    if (
      columns.length !== childColumns.length ||
      columns.some(
        (row, index) =>
          row.child_table !== child ||
          row.parent_table !== parent ||
          row.child_column !== childColumns[index] ||
          row.parent_column !== parentColumns[index] ||
          Number(row.ordinal) !== index + 1,
      )
    )
      throw new UpgradeProbeError(
        'A new-table composite foreign key lost tenant or assistant scope',
      );
  }
  const checks = [];
  const taskId = randomBytes(16);
  const taskSql =
    "INSERT INTO assistant_improvement (id, merchant_id, assistant_id, source_message_id, reason, question, expected_answer, notes, created_by, updated_by) VALUES (?, ?, ?, ?, 'missing_information', '升级后校验', '商家确认答案', '', ?, ?)";
  await connection.beginTransaction();
  try {
    await connection.execute(taskSql, [
      taskId,
      ids.merchant,
      ids.assistant,
      ids.visitor,
      ids.owner,
      ids.owner,
    ]);
    await connection.execute(
      "INSERT INTO assistant_evaluation_run (id, merchant_id, assistant_id, improvement_id, task_version, draft_revision, facts_hash, question, expected_answer, state, prompt_template_version, model_policy_version, created_by) VALUES (?, ?, ?, ?, 1, 2, ?, '升级后测试', '商家确认答案', 'pending', 'upgrade-v1', 'no-model-v1', ?)",
      [randomBytes(16), ids.merchant, ids.assistant, taskId, randomBytes(32), ids.owner],
    );
    checks.push(
      await assertConstraintRejected(
        () =>
          connection.execute(taskSql, [
            randomBytes(16),
            ids.merchant,
            ids.assistant,
            ids.visitor,
            ids.owner,
            ids.owner,
          ]),
        'ER_DUP_ENTRY',
        'unique_source_message',
      ),
    );
    checks.push(
      await assertConstraintRejected(
        () =>
          connection.execute(taskSql, [
            randomBytes(16),
            ids.merchant,
            ids.sameMerchantAssistant,
            ids.visitor,
            ids.owner,
            ids.owner,
          ]),
        'ER_NO_REFERENCED_ROW_2',
        'same_merchant_cross_assistant_source',
      ),
    );
    checks.push(
      await assertConstraintRejected(
        () =>
          connection.execute(taskSql, [
            randomBytes(16),
            ids.otherMerchant,
            ids.otherAssistant,
            ids.visitor,
            ids.owner,
            ids.owner,
          ]),
        'ER_NO_REFERENCED_ROW_2',
        'cross_merchant_source',
      ),
    );
    checks.push(
      await assertConstraintRejected(
        () =>
          connection.execute(
            "INSERT INTO assistant_evaluation_run (id, merchant_id, assistant_id, improvement_id, task_version, draft_revision, facts_hash, question, expected_answer, state, prompt_template_version, model_policy_version, created_by) VALUES (?, ?, ?, ?, 1, 2, ?, '错误客服', '', 'pending', 'upgrade-v1', 'no-model-v1', ?)",
            [
              randomBytes(16),
              ids.merchant,
              ids.sameMerchantAssistant,
              taskId,
              randomBytes(32),
              ids.owner,
            ],
          ),
        'ER_NO_REFERENCED_ROW_2',
        'cross_assistant_evaluation',
      ),
    );
  } finally {
    await connection.rollback();
  }
  for (const table of ['assistant_improvement', 'assistant_evaluation_run']) {
    const [rows] = await connection.query(`SELECT COUNT(*) AS count FROM ${quote(table)}`);
    if (Number(rows[0].count) !== 0)
      throw new UpgradeProbeError('Constraint-check data escaped its rollback transaction');
  }
  return {
    engines: 'InnoDB',
    compositeForeignKeys: Object.keys(expected).length,
    checks,
    testWritesRolledBack: true,
  };
}

async function seedPostUpgradeData(connection, ids) {
  const taskId = randomBytes(16);
  await connection.beginTransaction();
  try {
    await connection.execute(
      "INSERT INTO assistant_improvement (id, merchant_id, assistant_id, source_session_id, source_message_id, source_release_id, reason, question, expected_answer, notes, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, 'missing_information', '寄新疆包邮吗？', '运费需联系商家核实，不承诺包邮。', '仅为升级重放数据保持夹具', ?, ?)",
      [
        taskId,
        ids.merchant,
        ids.assistant,
        ids.session,
        ids.visitor,
        ids.release,
        ids.owner,
        ids.owner,
      ],
    );
    await connection.execute(
      "INSERT INTO assistant_evaluation_run (id, merchant_id, assistant_id, improvement_id, task_version, draft_revision, facts_hash, question, expected_answer, state, error_code, prompt_template_version, model_policy_version, created_by, completed_at) VALUES (?, ?, ?, ?, 1, 2, ?, '寄新疆包邮吗？', '运费需联系商家核实，不承诺包邮。', 'failed', 'synthetic_no_model', 'upgrade-fixture-v1', 'synthetic-no-model-v1', ?, UTC_TIMESTAMP(6))",
      [randomBytes(16), ids.merchant, ids.assistant, taskId, randomBytes(32), ids.owner],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

export async function runUpgradeProbe(environment = process.env) {
  let phase = 'validate_target';
  let password;
  let connection;
  let locked = false;
  let scratch;
  try {
    const target = validateUpgradeTarget(environment);
    phase = 'review_migration_plan';
    const plan = await reviewedUpgradePlan();
    phase = 'read_ci_credential';
    try {
      password = decodeURIComponent(new URL(environment.H5CS_INTEGRATION_MYSQL_URL).password);
    } catch {
      throw new UpgradeProbeError('CI credential encoding is invalid');
    }
    phase = 'load_database_driver';
    const [{ createConnection }, { drizzle }, { migrate }] = await Promise.all([
      import('mysql2/promise'),
      import('drizzle-orm/mysql2'),
      import('drizzle-orm/mysql2/migrator'),
    ]);
    phase = 'connect_database';
    connection = await createConnection({
      ...target,
      password,
      timezone: 'Z',
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    password = undefined;
    phase = 'acquire_migration_lock';
    const migrationLock = await acquireMigrationLock(connection);
    locked = true;
    phase = 'verify_empty_database';
    await assertEmptyCiDatabase(connection);
    phase = 'read_mysql_version';
    const mysqlVersion = await readMysqlVersion(connection);
    phase = 'prepare_baseline_migrations';
    scratch = await baselineMigrationFolder(plan);
    const db = drizzle({ client: connection });
    phase = 'apply_twelve_migrations';
    await migrate(db, { migrationsFolder: scratch.folder });
    phase = 'verify_baseline_history';
    const baselineHistory = await assertMigrationHistory(
      connection,
      plan.entries.slice(0, expectedBaselineCount),
    );
    phase = 'inspect_baseline_schema';
    const tables = await applicationTables(connection);
    if (
      tables.length !== 29 ||
      tables.includes('assistant_improvement') ||
      tables.includes('assistant_evaluation_run')
    )
      throw new UpgradeProbeError('Baseline is not the real pre-0012 application schema');
    phase = 'seed_baseline_data';
    const ids = await seedBaselineData(connection);
    phase = 'snapshot_baseline_data';
    const before = await snapshotTables(connection, tables, { legacyJobProjection: true });
    for (const [table, minimum] of [
      ['merchant', 2],
      ['assistant', 3],
      ['assistant_draft', 3],
      ['assistant_release', 1],
      ['conversation_session', 1],
      ['message', 2],
      ['knowledge_revision', 1],
      ['job', 1],
      ['audit_log', 1],
    ]) {
      if ((before.tables.find((entry) => entry.table === table)?.count ?? 0) < minimum)
        throw new UpgradeProbeError(
          'Baseline fixture is missing representative non-empty business data',
        );
    }
    phase = 'apply_thirteenth_migration';
    await migrate(db, { migrationsFolder: sourceFolder });
    phase = 'verify_upgraded_history';
    const upgradedHistory = await assertMigrationHistory(connection, plan.entries);
    phase = 'verify_preserved_legacy_data';
    const after = await snapshotTables(connection, tables, { legacyJobProjection: true });
    if (before.sha256 !== after.sha256)
      throw new UpgradeProbeError('Existing business rows or schema changed during 0012 upgrade');
    phase = 'verify_upgraded_schema';
    const fullTables = await applicationTables(connection);
    assertUpgradedTableSet(fullTables, tables);
    phase = 'verify_new_table_constraints';
    const constraints = await assertNewTableConstraints(connection, ids);
    phase = 'seed_post_upgrade_data';
    await seedPostUpgradeData(connection, ids);
    const newTables = ['assistant_evaluation_run', 'assistant_improvement'];
    phase = 'snapshot_new_table_data';
    const beforeReplayNewData = await snapshotTables(connection, newTables);
    if (beforeReplayNewData.tables.some((table) => table.count !== 1))
      throw new UpgradeProbeError('Post-upgrade data is not populated for the replay check');
    phase = 'replay_thirteen_migrations';
    await migrate(db, { migrationsFolder: sourceFolder });
    phase = 'verify_replay_history';
    const replayHistory = await assertMigrationHistory(connection, plan.entries);
    phase = 'verify_replayed_data';
    const repeated = await snapshotTables(connection, tables, { legacyJobProjection: true });
    const afterReplayNewData = await snapshotTables(connection, newTables);
    if (
      repeated.sha256 !== before.sha256 ||
      JSON.stringify(replayHistory) !== JSON.stringify(upgradedHistory) ||
      beforeReplayNewData.sha256 !== afterReplayNewData.sha256
    )
      throw new UpgradeProbeError(
        'Migration replay duplicated records or altered existing business data',
      );
    return {
      kind: 'h5cs-ci-mysql-upgrade',
      syntheticDataOnly: true,
      modelCalled: false,
      target,
      mysqlVersion,
      migrationLock,
      fromMigrationCount: baselineHistory.length,
      toMigrationCount: upgradedHistory.length,
      planSha256: plan.inventory.planSha256,
      beforeSha256: before.sha256,
      afterSha256: after.sha256,
      replaySha256: repeated.sha256,
      legacyTables: before.tables,
      baselineHistory,
      upgradedHistory,
      replayHistoryUnchanged: true,
      newTableDataReplayUnchanged: true,
      newTableData: beforeReplayNewData.tables,
      constraints,
      boundary:
        'Real pre-0012 schema with synthetic persisted data, not an old-binary feature-compatibility or production migration claim',
    };
  } catch (error) {
    throw safeProbeFailure(error, phase);
  } finally {
    password = undefined;
    if (locked)
      await connection
        .query("SELECT RELEASE_LOCK('h5cs_schema_migration_v1')")
        .catch(() => undefined);
    if (connection) await connection.end().catch(() => undefined);
    if (scratch) {
      try {
        await scratch.cleanup();
      } catch (error) {
        throw safeProbeFailure(error, 'cleanup_migration_scratch');
      }
    }
  }
}

export async function main(args = process.argv.slice(2), environment = process.env) {
  const options = parseUpgradeArguments(args);
  const target = validateUpgradeTarget(environment);
  if (options.action === 'check-target') {
    const plan = await reviewedUpgradePlan();
    process.stdout.write(
      `${JSON.stringify({ action: options.action, target, migrationCount: plan.entries.length, noDatabaseConnected: true })}\n`,
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(await runUpgradeProbe(environment), null, 2)}\n`);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${safeProbeFailure(error, 'cli_preflight').message}\n`);
    process.exitCode = 1;
  });
}
