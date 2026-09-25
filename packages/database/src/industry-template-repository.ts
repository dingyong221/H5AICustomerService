import { randomBytes, randomUUID } from 'node:crypto';

import type { RowDataPacket } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from './config.js';

export type IndustryTemplateGuide = Readonly<{
  id: string;
  code: string;
  version: number;
  displayName: string;
  referenceNotes: string;
  requiredMaterials: readonly string[];
  requiredPolicies: readonly string[];
}>;

export class IndustryTemplateAlreadyExistsError extends Error {
  public constructor() {
    super('Industry template code/version already exists');
    this.name = 'IndustryTemplateAlreadyExistsError';
  }
}

type IndustryTemplateRow = RowDataPacket & {
  id: Buffer;
  code: string;
  version: number;
  display_name: string;
  required_materials: unknown;
  required_policies: unknown;
  template: unknown;
};

const decodeJson = (value: unknown): unknown =>
  typeof value === 'string' ? (JSON.parse(value) as unknown) : value;

const text = (value: string, maximum: number): string => {
  const normalized = value.replace(/\r\n?/gu, '\n').trim();
  if (
    !normalized ||
    normalized.length > maximum ||
    /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error('Industry template text is invalid');
  }
  return normalized;
};

const items = (value: readonly string[], required: boolean): readonly string[] => {
  if (!Array.isArray(value) || value.length > 12 || (required && value.length === 0)) {
    throw new Error('Industry template items are invalid');
  }
  const normalized = value.map((item) => text(item, 200));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Industry template items must be distinct');
  }
  return normalized;
};

const decodeItems = (value: unknown): readonly string[] => {
  const parsed = decodeJson(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('Industry template items are malformed');
  }
  return items(parsed, false);
};

const decodeGuide = (row: IndustryTemplateRow): IndustryTemplateGuide => {
  const parsed = decodeJson(row.template);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Industry template reference is malformed');
  }
  const referenceNotes = (parsed as Record<string, unknown>)['referenceNotes'];
  if (typeof referenceNotes !== 'string') {
    throw new Error('Industry template reference is malformed');
  }
  return {
    id: row.id.toString('hex'),
    code: row.code,
    version: row.version,
    displayName: row.display_name,
    referenceNotes: text(referenceNotes, 4_000),
    requiredMaterials: decodeItems(row.required_materials),
    requiredPolicies: decodeItems(row.required_policies),
  };
};

export class MySqlIndustryTemplateRepository {
  public constructor(private readonly database: DatabaseConnectionConfig) {}

  public async listActive(limit = 100): Promise<readonly IndustryTemplateGuide[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Industry template list limit is invalid');
    }
    const connection = await this.database.openConnection();
    try {
      const [rows] = await connection.execute<IndustryTemplateRow[]>(
        `SELECT t.id, t.code, t.version, t.display_name,
                t.required_materials, t.required_policies, t.template
           FROM industry_template t
           JOIN (SELECT code, MAX(version) AS version
                   FROM industry_template WHERE status = 'active' GROUP BY code) latest
             ON latest.code = t.code AND latest.version = t.version
          WHERE t.status = 'active'
          ORDER BY t.display_name, t.code LIMIT ?`,
        [limit],
      );
      return rows.map(decodeGuide);
    } finally {
      await connection.end();
    }
  }

  public async create(input: {
    code: string;
    version: number;
    displayName: string;
    referenceNotes: string;
    requiredMaterials: readonly string[];
    requiredPolicies: readonly string[];
    operatorId: string;
  }): Promise<IndustryTemplateGuide> {
    if (!/^[a-z][a-z0-9_-]{1,63}$/u.test(input.code)) {
      throw new Error('Industry template code is invalid');
    }
    if (!Number.isSafeInteger(input.version) || input.version < 1 || input.version > 100_000) {
      throw new Error('Industry template version is invalid');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.operatorId)) {
      throw new Error('Platform operator ID is invalid');
    }
    const displayName = text(input.displayName, 128);
    const referenceNotes = text(input.referenceNotes, 4_000);
    const requiredMaterials = items(input.requiredMaterials, true);
    const requiredPolicies = items(input.requiredPolicies, false);
    const templateId = randomBytes(16);
    const guide: IndustryTemplateGuide = {
      id: templateId.toString('hex'),
      code: input.code,
      version: input.version,
      displayName,
      referenceNotes,
      requiredMaterials,
      requiredPolicies,
    };
    const connection = await this.database.openConnection();
    try {
      await connection.beginTransaction();
      try {
        await connection.execute(
          `INSERT INTO industry_template
             (id, code, version, display_name, status,
              required_materials, required_policies, template, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
          [
            templateId,
            guide.code,
            guide.version,
            guide.displayName,
            JSON.stringify(guide.requiredMaterials),
            JSON.stringify(guide.requiredPolicies),
            JSON.stringify({ referenceNotes: guide.referenceNotes }),
          ],
        );
        await connection.execute(
          `INSERT INTO audit_log
             (id, merchant_id, actor_type, actor_id, action, target_type, target_id,
              result, request_id, metadata, occurred_at, created_at)
           VALUES (?, NULL, 'platform_operator', ?, 'industry_template.create',
                   'industry_template', ?, 'success', ?, ?,
                   UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
          [
            randomBytes(16),
            input.operatorId,
            guide.id,
            randomUUID(),
            JSON.stringify({ code: guide.code, version: guide.version }),
          ],
        );
        await connection.commit();
        return guide;
      } catch (error) {
        await connection.rollback();
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ER_DUP_ENTRY'
        ) {
          throw new IndustryTemplateAlreadyExistsError();
        }
        throw error;
      }
    } finally {
      await connection.end();
    }
  }
}
