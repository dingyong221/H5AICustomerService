import type { Connection, RowDataPacket } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from './config.js';

const DAY = 86_400_000;
const BEIJING_OFFSET = 8 * 3_600_000;
export const PLATFORM_REPORT_MAX_DAYS = 93;
export const PLATFORM_REPORT_EXPORT_LIMIT = 5_000;
export type PlatformReportRange = Readonly<{ from: string; to: string }>;

const dayMillis = (value: string): number => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error('Invalid report date');
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw new Error('Invalid report date');
  }
  return time;
};

export function platformReportRange(
  input: { from?: string; to?: string; days?: number } = {},
  now = new Date(),
): PlatformReportRange {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid report clock');
  const today = new Date(now.getTime() + BEIJING_OFFSET).toISOString().slice(0, 10);
  if ((input.from === undefined) !== (input.to === undefined))
    throw new Error('Both report dates are required');
  const days = input.days ?? 7;
  if (!Number.isInteger(days) || days < 1 || days > PLATFORM_REPORT_MAX_DAYS)
    throw new Error('Invalid report duration');
  const to = input.to ?? today;
  const from = input.from ?? new Date(dayMillis(to) - (days - 1) * DAY).toISOString().slice(0, 10);
  const length = (dayMillis(to) - dayMillis(from)) / DAY + 1;
  if (length < 1 || length > PLATFORM_REPORT_MAX_DAYS || to > today || from < '2000-01-01') {
    throw new Error('Report range must be past or current Beijing dates, up to 93 days');
  }
  return { from, to };
}

export function platformReportDays(range: PlatformReportRange): readonly string[] {
  const valid = platformReportRange(range);
  const days: string[] = [];
  for (let at = dayMillis(valid.from); at <= dayMillis(valid.to); at += DAY)
    days.push(new Date(at).toISOString().slice(0, 10));
  return days;
}

// UTC strings avoid mysql2 serializing JS Date parameters in the host timezone.
const sqlWindow = (range: PlatformReportRange): readonly [string, string] => {
  const valid = platformReportRange(range);
  const sql = (at: number) => new Date(at).toISOString().slice(0, 23).replace('T', ' ');
  return [
    sql(dayMillis(valid.from) - BEIJING_OFFSET),
    sql(dayMillis(valid.to) + DAY - BEIJING_OFFSET),
  ];
};
const validId = (value: string): Buffer => {
  if (!/^[0-9a-f]{32}$/u.test(value)) throw new Error('Invalid analytics merchant ID');
  return Buffer.from(value, 'hex');
};
const count = (value: unknown): number => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/u.test(value)))
    throw new Error('Invalid analytics count');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid analytics count');
  return result;
};
const mean = (value: unknown): number | null => {
  if (value == null) return null;
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value)))
    throw new Error('Invalid analytics duration');
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error('Invalid analytics duration');
  return Math.round(result);
};
const iso = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error('Invalid analytics timestamp');
  return value;
};
const optionalIso = (value: unknown) => (value == null ? null : iso(value));
type Row = RowDataPacket & Record<string, unknown>;
type SqlValue = string | number | Buffer | null;
const select = async (
  connection: Connection,
  sql: string,
  values: readonly SqlValue[] = [],
): Promise<Row[]> => {
  const [rows] = await connection.execute<Row[]>(sql, [...values]);
  return rows;
};
const first = (rows: readonly Row[]): Row => {
  if (!rows[0]) throw new Error('Analytics aggregate missing');
  return rows[0];
};

export type PlatformUsage = Readonly<{
  sessions: number;
  questions: number;
  completed: number;
  failed: number;
  pending: number;
  meanResponseMs: number | null;
}>;
export type PlatformUsageDay = PlatformUsage & Readonly<{ day: string; newMerchants: number }>;
export type PlatformInventory = Readonly<{
  merchants: number;
  pendingOwner: number;
  enabledMerchants: number;
  pausedMerchants: number;
  assistants: number;
  publishedAssistants: number;
}>;
export type PlatformQuality = Readonly<{
  improvements: number;
  publishedImprovements: number;
  evaluations: number;
  evaluationCompleted: number;
  evaluationFailed: number;
  evaluationPending: number;
  verdictPass: number;
  verdictFail: number;
  unreviewed: number;
}>;
export type PlatformErrorGroup = Readonly<{
  source: 'conversation' | 'job';
  type: string;
  code: string;
  total: number;
}>;
export type PlatformAnalytics = Readonly<{
  range: PlatformReportRange;
  generatedAt: string;
  inventory: PlatformInventory;
  usingMerchants: number;
  usage: PlatformUsage;
  daily: readonly PlatformUsageDay[];
  quality: PlatformQuality;
  errors: readonly PlatformErrorGroup[];
}>;
export type PlatformMerchantUsage = PlatformUsage &
  Readonly<{
    id: string;
    name: string;
    status: string;
    createdAt: string;
    assistants: number;
    publishedAssistants: number;
    lastConsultationAt: string | null;
  }>;
export type PlatformAssistantUsage = PlatformUsage &
  Readonly<{
    id: string;
    merchantId: string;
    merchantName: string;
    displayName: string;
    status: string;
    releaseId: string | null;
  }>;
export type PlatformUsagePage<T> = Readonly<{
  items: readonly T[];
  total: number;
  page: number;
  pageSize: number;
  generatedAt: string;
}>;
export type PlatformMerchantFilters = Readonly<{
  search?: string;
  status?: 'all' | 'pending_owner' | 'active' | 'paused';
  activity?: 'all' | 'used' | 'unused';
  sort?: 'recent' | 'questions' | 'sessions' | 'failed';
  merchantId?: string;
}>;

const usage = (row: Row): PlatformUsage => ({
  sessions: count(row['sessions']),
  questions: count(row['questions']),
  completed: count(row['completed']),
  failed: count(row['failed']),
  pending: count(row['pending']),
  meanResponseMs: mean(row['mean_response_ms']),
});
const questionAggregates = `COUNT(*) AS questions,
  COALESCE(SUM(state = 'completed'), 0) AS completed,
  COALESCE(SUM(state = 'failed'), 0) AS failed,
  COALESCE(SUM(state NOT IN ('completed', 'failed')), 0) AS pending,
  AVG(CASE WHEN state = 'completed' AND completed_at >= created_at
      THEN TIMESTAMPDIFF(MICROSECOND, created_at, completed_at) / 1000 END) AS mean_response_ms`;
const utc = (column: string) => `DATE_FORMAT(${column}, '%Y-%m-%dT%H:%i:%s.%fZ')`;
const day = (column: string) => `DATE_FORMAT(DATE_ADD(${column}, INTERVAL 8 HOUR), '%Y-%m-%d')`;

function merchantCriteria(filters: PlatformMerchantFilters, range: PlatformReportRange) {
  const conditions: string[] = [],
    values: SqlValue[] = [];
  const status = filters.status ?? 'all',
    activity = filters.activity ?? 'all';
  if (
    !['all', 'pending_owner', 'active', 'paused'].includes(status) ||
    !['all', 'used', 'unused'].includes(activity)
  )
    throw new Error('Invalid merchant filters');
  if (status !== 'all') {
    conditions.push('m.status = ?');
    values.push(status);
  }
  if (filters.merchantId !== undefined) {
    conditions.push('m.id = ?');
    values.push(validId(filters.merchantId));
  }
  if (filters.search !== undefined && filters.search !== '') {
    const term = filters.search.trim();
    if (term.length < 2 || term.length > 100 || /[\u0000-\u001f\u007f]/u.test(term))
      throw new Error('Invalid merchant search');
    if (/^[0-9a-f]{32}$/iu.test(term)) {
      conditions.push('m.id = ?');
      values.push(Buffer.from(term, 'hex'));
    } else {
      conditions.push("m.name LIKE ? ESCAPE '!'");
      values.push(`%${term.replace(/[!%_]/gu, '!$&')}%`);
    }
  }
  if (activity !== 'all') {
    conditions.push(`${activity === 'unused' ? 'NOT ' : ''}EXISTS (
      SELECT 1 FROM message activity WHERE activity.merchant_id = m.id AND activity.role = 'visitor'
        AND activity.created_at >= ? AND activity.created_at < ?)`);
    values.push(...sqlWindow(range));
  }
  return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values };
}
const merchantOrder = (sort: PlatformMerchantFilters['sort'] = 'recent'): string => {
  const options = {
    recent: 'm.created_at DESC, m.id DESC',
    questions: 'questions DESC, m.id DESC',
    sessions: 'sessions DESC, m.id DESC',
    failed: 'failed DESC, m.id DESC',
  };
  if (!Object.hasOwn(options, sort)) throw new Error('Invalid merchant sort');
  return options[sort];
};
const pageBounds = (page: number, pageSize: number) => {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 100_000 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > PLATFORM_REPORT_EXPORT_LIMIT + 1
  )
    throw new Error('Invalid analytics page');
  return [pageSize, (page - 1) * pageSize];
};

export class MySqlPlatformAnalyticsRepository {
  public constructor(private readonly database: DatabaseConnectionConfig) {}

  // A short-lived repeatable-read, read-only snapshot, never model calls or
  // business writes. The execution limit applies to each SELECT in this session.
  private async snapshot<T>(
    read: (connection: Connection, generatedAt: string) => Promise<T>,
  ): Promise<T> {
    const connection = await this.database.openConnection();
    try {
      await connection.query('SET SESSION MAX_EXECUTION_TIME = 8000');
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      await connection.beginTransaction();
      try {
        const generatedAt = iso(
          first(await select(connection, `SELECT ${utc('UTC_TIMESTAMP(6)')} AS generated_at`))[
            'generated_at'
          ],
        );
        const result = await read(connection, generatedAt);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      }
    } finally {
      await connection.end().catch(() => undefined);
    }
  }

  public async analytics(
    range: PlatformReportRange,
    merchantId?: string,
  ): Promise<PlatformAnalytics> {
    const window = sqlWindow(range),
      scopeValues = merchantId === undefined ? [] : [validId(merchantId)];
    const scope = merchantId === undefined ? '' : ' AND merchant_id = ?';
    return this.snapshot(async (connection, generatedAt) => {
      const inventory = first(
        await select(
          connection,
          `SELECT COUNT(*) AS merchants,
        COALESCE(SUM(status = 'pending_owner'), 0) AS pending_owner,
        COALESCE(SUM(status = 'active'), 0) AS enabled_merchants,
        COALESCE(SUM(status = 'paused'), 0) AS paused_merchants
        FROM merchant${merchantId === undefined ? '' : ' WHERE id = ?'}`,
          scopeValues,
        ),
      );
      const assistants = first(
        await select(
          connection,
          `SELECT COUNT(*) AS assistants,
        COALESCE(SUM(status = 'active' AND active_release_id IS NOT NULL), 0) AS published_assistants
        FROM assistant WHERE 1 = 1${scope}`,
          scopeValues,
        ),
      );
      const conversations = first(
        await select(
          connection,
          `SELECT COUNT(*) AS sessions
        FROM conversation_session WHERE created_at >= ? AND created_at < ?${scope}`,
          [...window, ...scopeValues],
        ),
      );
      const questions = first(
        await select(
          connection,
          `SELECT ${questionAggregates}, COUNT(DISTINCT merchant_id) AS using_merchants
        FROM message WHERE role = 'visitor' AND created_at >= ? AND created_at < ?${scope}`,
          [...window, ...scopeValues],
        ),
      );
      const questionDays = await select(
        connection,
        `SELECT ${day('created_at')} AS day, ${questionAggregates}
        FROM message WHERE role = 'visitor' AND created_at >= ? AND created_at < ?${scope}
        GROUP BY day ORDER BY day`,
        [...window, ...scopeValues],
      );
      const sessionDays = await select(
        connection,
        `SELECT ${day('created_at')} AS day, COUNT(*) AS sessions
        FROM conversation_session WHERE created_at >= ? AND created_at < ?${scope}
        GROUP BY day ORDER BY day`,
        [...window, ...scopeValues],
      );
      const merchantDays = await select(
        connection,
        `SELECT ${day('created_at')} AS day, COUNT(*) AS new_merchants
        FROM merchant WHERE created_at >= ? AND created_at < ?${merchantId === undefined ? '' : ' AND id = ?'}
        GROUP BY day ORDER BY day`,
        [...window, ...scopeValues],
      );
      const improvements = first(
        await select(
          connection,
          `SELECT COUNT(*) AS improvements,
        COALESCE(SUM(published_release_id IS NOT NULL AND published_task_version = version), 0) AS published_improvements
        FROM assistant_improvement WHERE created_at >= ? AND created_at < ?${scope}`,
          [...window, ...scopeValues],
        ),
      );
      const evaluations = first(
        await select(
          connection,
          `SELECT COUNT(*) AS evaluations,
        COALESCE(SUM(state = 'completed'), 0) AS evaluation_completed,
        COALESCE(SUM(state = 'failed'), 0) AS evaluation_failed,
        COALESCE(SUM(state = 'pending'), 0) AS evaluation_pending,
        COALESCE(SUM(state = 'completed' AND verdict = 'pass'), 0) AS verdict_pass,
        COALESCE(SUM(state = 'completed' AND verdict = 'fail'), 0) AS verdict_fail,
        COALESCE(SUM(state = 'completed' AND verdict IS NULL), 0) AS unreviewed
        FROM assistant_evaluation_run WHERE created_at >= ? AND created_at < ?${scope}`,
          [...window, ...scopeValues],
        ),
      );
      const errors = await select(
        connection,
        `SELECT 'conversation' AS source, 'consumer_question' AS type,
          COALESCE(error_code, 'not_recorded') AS code, COUNT(*) AS total
        FROM message WHERE role = 'visitor' AND state = 'failed' AND created_at >= ? AND created_at < ?${scope}
        GROUP BY code
        UNION ALL
        SELECT 'job' AS source, type, COALESCE(last_error_code, 'not_recorded') AS code, COUNT(*) AS total
        FROM job WHERE state = 'failed' AND created_at >= ? AND created_at < ?${scope}
        GROUP BY type, code
        ORDER BY total DESC, source, type, code LIMIT ${PLATFORM_REPORT_EXPORT_LIMIT + 1}`,
        [...window, ...scopeValues, ...window, ...scopeValues],
      );
      const q = new Map(questionDays.map((row) => [String(row['day']), row]));
      const s = new Map(sessionDays.map((row) => [String(row['day']), count(row['sessions'])]));
      const m = new Map(
        merchantDays.map((row) => [String(row['day']), count(row['new_merchants'])]),
      );
      return {
        range,
        generatedAt,
        inventory: {
          merchants: count(inventory['merchants']),
          pendingOwner: count(inventory['pending_owner']),
          enabledMerchants: count(inventory['enabled_merchants']),
          pausedMerchants: count(inventory['paused_merchants']),
          assistants: count(assistants['assistants']),
          publishedAssistants: count(assistants['published_assistants']),
        },
        usingMerchants: count(questions['using_merchants']),
        usage: usage({ ...questions, ...conversations } as Row),
        daily: platformReportDays(range).map((day) => ({
          day,
          newMerchants: m.get(day) ?? 0,
          sessions: s.get(day) ?? 0,
          questions: q.has(day) ? count(q.get(day)!['questions']) : 0,
          completed: q.has(day) ? count(q.get(day)!['completed']) : 0,
          failed: q.has(day) ? count(q.get(day)!['failed']) : 0,
          pending: q.has(day) ? count(q.get(day)!['pending']) : 0,
          meanResponseMs: q.has(day) ? mean(q.get(day)!['mean_response_ms']) : null,
        })),
        quality: {
          improvements: count(improvements['improvements']),
          publishedImprovements: count(improvements['published_improvements']),
          evaluations: count(evaluations['evaluations']),
          evaluationCompleted: count(evaluations['evaluation_completed']),
          evaluationFailed: count(evaluations['evaluation_failed']),
          evaluationPending: count(evaluations['evaluation_pending']),
          verdictPass: count(evaluations['verdict_pass']),
          verdictFail: count(evaluations['verdict_fail']),
          unreviewed: count(evaluations['unreviewed']),
        },
        errors: errors.map((row) => {
          if (row['source'] !== 'conversation' && row['source'] !== 'job')
            throw new Error('Invalid analytics error source');
          return {
            source: row['source'],
            type: String(row['type']),
            code: String(row['code']),
            total: count(row['total']),
          };
        }),
      };
    });
  }

  public async merchants(
    range: PlatformReportRange,
    filters: PlatformMerchantFilters = {},
    page = 1,
    pageSize = 20,
  ): Promise<PlatformUsagePage<PlatformMerchantUsage>> {
    const window = sqlWindow(range),
      criteria = merchantCriteria(filters, range),
      order = merchantOrder(filters.sort),
      bounds = pageBounds(page, pageSize);
    return this.snapshot(async (connection, generatedAt) => {
      const total = count(
        first(
          await select(
            connection,
            `SELECT COUNT(*) AS total FROM merchant m ${criteria.sql}`,
            criteria.values,
          ),
        )['total'],
      );
      const rows = await select(
        connection,
        `SELECT m.id, m.name, m.status, ${utc('m.created_at')} AS created_at,
          COALESCE(a.assistants, 0) AS assistants, COALESCE(a.published_assistants, 0) AS published_assistants,
          COALESCE(s.sessions, 0) AS sessions, COALESCE(q.questions, 0) AS questions,
          COALESCE(q.completed, 0) AS completed, COALESCE(q.failed, 0) AS failed, COALESCE(q.pending, 0) AS pending,
          q.mean_response_ms, ${utc('last_question.at')} AS last_consultation_at
        FROM merchant m
        LEFT JOIN (SELECT merchant_id, COUNT(*) AS assistants, SUM(status = 'active' AND active_release_id IS NOT NULL) AS published_assistants FROM assistant GROUP BY merchant_id) a ON a.merchant_id = m.id
        LEFT JOIN (SELECT merchant_id, COUNT(*) AS sessions FROM conversation_session WHERE created_at >= ? AND created_at < ? GROUP BY merchant_id) s ON s.merchant_id = m.id
        LEFT JOIN (SELECT merchant_id, ${questionAggregates} FROM message WHERE role = 'visitor' AND created_at >= ? AND created_at < ? GROUP BY merchant_id) q ON q.merchant_id = m.id
        LEFT JOIN (SELECT merchant_id, MAX(created_at) AS at FROM message WHERE role = 'visitor' GROUP BY merchant_id) last_question ON last_question.merchant_id = m.id
        ${criteria.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
        [...window, ...window, ...criteria.values, ...bounds],
      );
      return {
        total,
        page,
        pageSize,
        generatedAt,
        items: rows.map((row) => ({
          ...usage(row),
          id: (row['id'] as Buffer).toString('hex'),
          name: String(row['name']),
          status: String(row['status']),
          createdAt: iso(row['created_at']),
          assistants: count(row['assistants']),
          publishedAssistants: count(row['published_assistants']),
          lastConsultationAt: optionalIso(row['last_consultation_at']),
        })),
      };
    });
  }

  public async assistants(
    range: PlatformReportRange,
    merchantId?: string,
    page = 1,
    pageSize = 20,
  ): Promise<PlatformUsagePage<PlatformAssistantUsage>> {
    const window = sqlWindow(range),
      scope = merchantId === undefined ? '' : 'WHERE a.merchant_id = ?',
      values = merchantId === undefined ? [] : [validId(merchantId)],
      bounds = pageBounds(page, pageSize);
    return this.snapshot(async (connection, generatedAt) => {
      const total = count(
        first(
          await select(connection, `SELECT COUNT(*) AS total FROM assistant a ${scope}`, values),
        )['total'],
      );
      const rows = await select(
        connection,
        `SELECT a.id, a.merchant_id, m.name AS merchant_name, a.display_name, a.status, a.active_release_id,
          COALESCE(s.sessions, 0) AS sessions, COALESCE(q.questions, 0) AS questions,
          COALESCE(q.completed, 0) AS completed, COALESCE(q.failed, 0) AS failed, COALESCE(q.pending, 0) AS pending, q.mean_response_ms
        FROM assistant a JOIN merchant m ON m.id = a.merchant_id
        LEFT JOIN (SELECT merchant_id, assistant_id, COUNT(*) AS sessions FROM conversation_session WHERE created_at >= ? AND created_at < ? GROUP BY merchant_id, assistant_id) s ON s.merchant_id = a.merchant_id AND s.assistant_id = a.id
        LEFT JOIN (SELECT merchant_id, assistant_id, ${questionAggregates} FROM message WHERE role = 'visitor' AND created_at >= ? AND created_at < ? GROUP BY merchant_id, assistant_id) q ON q.merchant_id = a.merchant_id AND q.assistant_id = a.id
        ${scope} ORDER BY questions DESC, a.merchant_id, a.id LIMIT ? OFFSET ?`,
        [...window, ...window, ...values, ...bounds],
      );
      return {
        total,
        page,
        pageSize,
        generatedAt,
        items: rows.map((row) => ({
          ...usage(row),
          id: (row['id'] as Buffer).toString('hex'),
          merchantId: (row['merchant_id'] as Buffer).toString('hex'),
          merchantName: String(row['merchant_name']),
          displayName: String(row['display_name']),
          status: String(row['status']),
          releaseId:
            row['active_release_id'] == null
              ? null
              : (row['active_release_id'] as Buffer).toString('hex'),
        })),
      };
    });
  }
}
