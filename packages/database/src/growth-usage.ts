import { createHash, randomBytes } from 'node:crypto';
import type { Connection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { z } from 'zod';
import type { DatabaseConnectionConfig } from './config.js';

export const growthEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env['H5CS_GROWTH_USAGE_ENABLED'] === 'true';
const id = (v: string) => {
  if (!/^[a-f0-9]{32}$/u.test(v)) throw Error('Invalid identity');
  return Buffer.from(v, 'hex');
};
export const usageDigest = (v: string) => createHash('sha256').update(v).digest();
export const usageBatchSchema = z
  .object({
    events: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            instance: z.string().uuid(),
            event: z.enum(['page_view', 'control_click', 'form_submit', 'active_time']),
            page: z.enum([
              'product',
              'registration',
              'login',
              'workspace',
              'drafts',
              'knowledge',
              'preview',
              'publish',
              'conversations',
              'improvements',
              'writing',
              'help',
              'invite',
              'consumer',
              'ops',
              'other',
            ]),
            control: z.enum([
              'page',
              'clock',
              'navigation',
              'unregistered_button',
              'unregistered_link',
              'unregistered_form',
              'product.register',
              'register.submit',
              'login.submit',
              'invite.create',
              'invite.copy',
              'invite.qr',
              'draft.save',
              'knowledge.upload',
              'knowledge.organize',
              'knowledge.save',
              'preview.send',
              'preview.pass',
              'publish.confirm',
              'share.copy',
              'share.qr',
              'help.open',
              'writing.generate',
              'conversation.send',
              'conversation.new',
              'logout',
            ]),
            activeMs: z.number().int().min(0).max(15000),
            at: z.string().datetime(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    publicRef: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/u)
      .optional(),
  })
  .strict();
export type UsageEvent = z.infer<typeof usageBatchSchema>['events'][number];
export type UsageIdentity = {
  role: 'anonymous' | 'merchant' | 'consumer' | 'operator';
  actor: string;
  merchantId?: string;
};

/** Called inside the allocation transaction, only for a genuinely new merchant. */
export async function bindGrowthReferral(
  c: Connection,
  touchToken: string | undefined,
  merchantId: Buffer,
  userId: Buffer,
) {
  if (!touchToken || !/^[A-Za-z0-9_-]{43}$/u.test(touchToken)) return;
  const [rows] = await c.execute<RowDataPacket[]>(
    `SELECT i.merchant_id FROM growth_touch t JOIN growth_invitation i ON i.merchant_id=t.inviter_id JOIN merchant m ON m.id=i.merchant_id JOIN merchant_membership mm ON mm.merchant_id=i.merchant_id AND mm.merchant_user_id=i.owner_id WHERE t.token_digest=? AND t.expires_at>UTC_TIMESTAMP(6) AND i.status='active' AND m.status='active' AND mm.status='active' AND mm.role='owner' AND i.merchant_id<>? AND i.owner_id<>? FOR UPDATE`,
    [usageDigest(touchToken), merchantId, userId],
  );
  if (rows.length === 1)
    await c.execute(
      'INSERT IGNORE INTO growth_referral (invitee_id,inviter_id,created_at) VALUES (?,?,UTC_TIMESTAMP(6))',
      [merchantId, rows[0]!['merchant_id']],
    );
}

export class MySqlGrowthUsageRepository {
  constructor(private readonly database: DatabaseConnectionConfig) {}
  async invitation(merchantId: string, userId: string, create = false): Promise<string | null> {
    const c = await this.database.openConnection();
    try {
      await c.beginTransaction();
      const [access] = await c.execute<RowDataPacket[]>(
        `SELECT mm.merchant_id FROM merchant_membership mm JOIN merchant m ON m.id=mm.merchant_id WHERE mm.merchant_id=? AND mm.merchant_user_id=? AND mm.role='owner' AND mm.status='active' AND m.status='active' FOR UPDATE`,
        [id(merchantId), id(userId)],
      );
      if (access.length !== 1) throw Error('Invitation access denied');
      if (create) {
        const [published] = await c.execute<RowDataPacket[]>(
          "SELECT id FROM assistant WHERE merchant_id=? AND active_release_id IS NOT NULL AND status='active' LIMIT 1",
          [id(merchantId)],
        );
        if (!published.length) throw Error('Publish your assistant before inviting');
        await c.execute(
          `INSERT IGNORE INTO growth_invitation (merchant_id,owner_id,public_code,status,created_at) VALUES (?,?,?,'active',UTC_TIMESTAMP(6))`,
          [id(merchantId), id(userId), randomBytes(32).toString('base64url')],
        );
      }
      const [rows] = await c.execute<RowDataPacket[]>(
        `SELECT public_code FROM growth_invitation WHERE merchant_id=? AND status='active'`,
        [id(merchantId)],
      );
      await c.commit();
      return (rows[0]?.['public_code'] as string) ?? null;
    } catch (e) {
      await c.rollback().catch(() => undefined);
      throw e;
    } finally {
      await c.end();
    }
  }
  async touch(code: string, existing?: string): Promise<{ token: string; expiresAt: Date } | null> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(code)) return null;
    const c = await this.database.openConnection();
    try {
      if (existing && /^[A-Za-z0-9_-]{43}$/u.test(existing)) {
        const [old] = await c.execute<RowDataPacket[]>(
          `SELECT expires_at FROM growth_touch WHERE token_digest=? AND expires_at>UTC_TIMESTAMP(6)`,
          [usageDigest(existing)],
        );
        if (old.length) return { token: existing, expiresAt: old[0]!['expires_at'] as Date };
      }
      const [rows] = await c.execute<RowDataPacket[]>(
        `SELECT i.merchant_id FROM growth_invitation i JOIN merchant m ON m.id=i.merchant_id WHERE i.public_code=? AND i.status='active' AND m.status='active'`,
        [code],
      );
      if (rows.length !== 1) return null;
      await c.beginTransaction();
      const [clock] = await c.execute<RowDataPacket[]>(
        "SELECT DATE_FORMAT(DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 8 HOUR),'%Y-%m-%d') day",
      );
      const day = String(clock[0]!['day']);
      await c.execute('INSERT IGNORE INTO product_usage_budget (day,accepted) VALUES (?,0)', [day]);
      const [budget] = await c.execute<RowDataPacket[]>(
        'SELECT accepted FROM product_usage_budget WHERE day=? FOR UPDATE',
        [day],
      );
      if (Number(budget[0]?.['accepted'] ?? 20000) >= 20000) {
        await c.rollback();
        return null;
      }
      const token = randomBytes(32).toString('base64url'),
        expiresAt = new Date(Date.now() + 30 * 86400000);
      await c.execute(
        'INSERT INTO growth_touch (token_digest,inviter_id,created_at,expires_at) VALUES (?,?,UTC_TIMESTAMP(6),?)',
        [usageDigest(token), rows[0]!['merchant_id'], expiresAt],
      );
      await c.execute('UPDATE product_usage_budget SET accepted=accepted+1 WHERE day=?', [day]);
      await c.commit();
      return { token, expiresAt };
    } catch (error) {
      await c.rollback().catch(() => undefined);
      throw error;
    } finally {
      await c.end();
    }
  }
  async invitationStats(merchantId?: string) {
    const c = await this.database.openConnection();
    try {
      const params = merchantId ? [id(merchantId)] : [],
        filter = merchantId ? ' WHERE r.inviter_id=?' : '';
      const [rows] = await c.execute<RowDataPacket[]>(
        `SELECT COUNT(*) opened,COALESCE(SUM(EXISTS(SELECT 1 FROM assistant_release a WHERE a.merchant_id=r.invitee_id AND a.activated_at IS NOT NULL)),0) published,COALESCE(SUM(EXISTS(SELECT 1 FROM message m WHERE m.merchant_id=r.invitee_id AND m.role='visitor' AND m.state='completed')),0) used FROM growth_referral r${filter}`,
        params,
      );
      const [touch] = await c.execute<RowDataPacket[]>(
        `SELECT COUNT(*) visits FROM growth_touch WHERE created_at>=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 30 DAY)${merchantId ? ' AND inviter_id=?' : ''}`,
        params,
      );
      return {
        visits: Number(touch[0]?.['visits'] ?? 0),
        opened: Number(rows[0]?.['opened'] ?? 0),
        published: Number(rows[0]?.['published'] ?? 0),
        used: Number(rows[0]?.['used'] ?? 0),
      };
    } finally {
      await c.end();
    }
  }
  async collect(identity: UsageIdentity, events: UsageEvent[]) {
    events = events.filter((e) => Math.abs(Date.now() - Date.parse(e.at)) <= 86400000);
    if (!events.length) return 0;
    const c = await this.database.openConnection();
    let accepted = 0;
    try {
      await c.beginTransaction();
      const [clock] = await c.execute<RowDataPacket[]>(
        "SELECT DATE_FORMAT(DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 8 HOUR),'%Y-%m-%d') day",
      );
      const day = String(clock[0]!['day']);
      // One fixed database row serializes the bounded daily budget across app instances.
      await c.execute('INSERT IGNORE INTO product_usage_budget (day,accepted) VALUES (?,0)', [day]);
      const [budget] = await c.execute<RowDataPacket[]>(
        'SELECT accepted FROM product_usage_budget WHERE day=? FOR UPDATE',
        [day],
      );
      if (Number(budget[0]?.['accepted'] ?? 20000) + events.length > 20000) {
        await c.rollback();
        return 0;
      }
      const actor = usageDigest(identity.role + ':' + identity.actor),
        merchant = identity.merchantId ? id(identity.merchantId) : null;
      await c.execute(
        'INSERT IGNORE INTO product_usage_actor (actor_digest,role,first_seen_at) VALUES (?,?,UTC_TIMESTAMP(6))',
        [actor, identity.role],
      );
      for (const e of events) {
        if (Math.abs(Date.now() - Date.parse(e.at)) > 86400000) continue;
        const active = e.event === 'active_time' ? e.activeMs : 0,
          hash = usageDigest(JSON.stringify([identity, e]));
        const [old] = await c.execute<RowDataPacket[]>(
          'SELECT payload_digest FROM product_usage_event WHERE event_id=?',
          [Buffer.from(e.id.replaceAll('-', ''), 'hex')],
        );
        if (old.length) {
          if (!(old[0]!['payload_digest'] as Buffer).equals(hash)) throw Error('Conflicting event');
          continue;
        }
        const [r] = await c.execute<ResultSetHeader>(
          'INSERT IGNORE INTO product_usage_event (event_id,payload_digest,actor_digest,role,merchant_id,page,event,control,page_instance,active_ms,client_at,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6))',
          [
            Buffer.from(e.id.replaceAll('-', ''), 'hex'),
            hash,
            actor,
            identity.role,
            merchant,
            e.page,
            e.event,
            e.control,
            Buffer.from(e.instance.replaceAll('-', ''), 'hex'),
            active,
            new Date(e.at),
          ],
        );
        if (!r.affectedRows) continue;
        accepted++;
        await c.execute(
          `INSERT INTO product_usage_day (actor_digest,day,role,merchant_id,views,actions,active_ms) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE views=views+VALUES(views),actions=actions+VALUES(actions),active_ms=LEAST(86400000,active_ms+VALUES(active_ms))`,
          [
            actor,
            day,
            identity.role,
            merchant,
            e.event === 'page_view' ? 1 : 0,
            e.event === 'control_click' || e.event === 'form_submit' ? 1 : 0,
            active,
          ],
        );
      }
      await c.execute('UPDATE product_usage_budget SET accepted=accepted+? WHERE day=?', [
        accepted,
        day,
      ]);
      await c.commit();
      return accepted;
    } catch (e) {
      await c.rollback().catch(() => undefined);
      throw e;
    } finally {
      await c.end();
    }
  }
  async cleanupExpired() {
    const c = await this.database.openConnection();
    const deleted: Record<string, number> = {};
    try {
      for (const [table, where] of [
        ['product_usage_event', 'received_at<DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 14 DAY)'],
        [
          'product_usage_day',
          "day<DATE_FORMAT(DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 180 DAY),'%Y-%m-%d')",
        ],
        ['growth_touch', 'expires_at<DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 60 DAY)'],
        [
          'product_usage_budget',
          "day<DATE_FORMAT(DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 30 DAY),'%Y-%m-%d')",
        ],
        [
          'product_usage_actor',
          'first_seen_at<DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 180 DAY) AND NOT EXISTS (SELECT 1 FROM product_usage_day d WHERE d.actor_digest=product_usage_actor.actor_digest)',
        ],
      ]) {
        const [r] = await c.execute<ResultSetHeader>(
          `DELETE FROM ${table} WHERE ${where} LIMIT 1000`,
        );
        deleted[table!] = r.affectedRows;
      }
      return deleted;
    } finally {
      await c.end();
    }
  }
  async usageReport() {
    const c = await this.database.openConnection();
    try {
      const [days] = await c.execute<RowDataPacket[]>(
        `SELECT day,role,COUNT(*) observed_users,SUM(views) views,SUM(actions) actions,SUM(active_ms) active_ms FROM product_usage_day WHERE day>=DATE_FORMAT(DATE_SUB(DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 8 HOUR),INTERVAL 30 DAY),'%Y-%m-%d') GROUP BY day,role ORDER BY day DESC,role`,
      );
      const [controls] = await c.execute<RowDataPacket[]>(
        `SELECT page,control,COUNT(*) clicks FROM product_usage_event WHERE received_at>=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 14 DAY) AND event='control_click' GROUP BY page,control ORDER BY clicks DESC LIMIT 30`,
      );
      const [retention] = await c.execute<RowDataPacket[]>(
        `SELECT DATE_FORMAT(DATE_ADD(a.first_seen_at,INTERVAL 8 HOUR),'%Y-%m-%d') cohort,a.role,COUNT(*) size,SUM(EXISTS(SELECT 1 FROM product_usage_day d WHERE d.actor_digest=a.actor_digest AND d.day=DATE_FORMAT(DATE_ADD(DATE_ADD(a.first_seen_at,INTERVAL 8 HOUR),INTERVAL 1 DAY),'%Y-%m-%d'))) d1,SUM(EXISTS(SELECT 1 FROM product_usage_day d WHERE d.actor_digest=a.actor_digest AND d.day=DATE_FORMAT(DATE_ADD(DATE_ADD(a.first_seen_at,INTERVAL 8 HOUR),INTERVAL 7 DAY),'%Y-%m-%d'))) d7,SUM(EXISTS(SELECT 1 FROM product_usage_day d WHERE d.actor_digest=a.actor_digest AND d.day=DATE_FORMAT(DATE_ADD(DATE_ADD(a.first_seen_at,INTERVAL 8 HOUR),INTERVAL 30 DAY),'%Y-%m-%d'))) d30 FROM product_usage_actor a WHERE a.first_seen_at>=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 60 DAY) GROUP BY cohort,a.role ORDER BY cohort DESC,a.role LIMIT 120`,
      );
      return { days, controls, retention };
    } finally {
      await c.end();
    }
  }
}
