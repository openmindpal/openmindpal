import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";

export const governanceIntegrationsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/governance/integrations", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "changeset.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.read" });
    req.ctx.audit!.policyDecision = decision;
    const q = z
      .object({
        scopeType: z.enum(["tenant", "space"]).optional(),
        limit: z.coerce.number().int().positive().max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(req.query);

    const scopeType = q.scopeType ?? (subject.spaceId ? "space" : "tenant");
    const scopeId = scopeType === "space" ? subject.spaceId : subject.tenantId;
    if (!scopeId) throw Errors.badRequest("缺少 scopeId");

    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;

    const oauth =
      scopeType === "space"
        ? await app.db.query(
            `
              SELECT g.grant_id, g.provider, g.status, g.created_at, g.updated_at, ci.id AS connector_instance_id, ci.name AS connector_name, ci.type_name AS connector_type
              FROM oauth_grants g
              JOIN connector_instances ci ON ci.id = g.connector_instance_id
              WHERE g.tenant_id = $1 AND g.space_id = $2
              ORDER BY g.updated_at DESC
              LIMIT $3 OFFSET $4
            `,
            [subject.tenantId, scopeId, limit, offset],
          )
        : await app.db.query(
            `
              SELECT g.grant_id, g.provider, g.status, g.created_at, g.updated_at, ci.id AS connector_instance_id, ci.name AS connector_name, ci.type_name AS connector_type
              FROM oauth_grants g
              JOIN connector_instances ci ON ci.id = g.connector_instance_id
              WHERE g.tenant_id = $1
              ORDER BY g.updated_at DESC
              LIMIT $2 OFFSET $3
            `,
            [subject.tenantId, limit, offset],
          );

    const subs =
      scopeType === "space"
        ? await app.db.query(
            `
              SELECT s.subscription_id, s.provider, s.status, s.last_run_at, s.updated_at, s.space_id, s.connector_instance_id,
                     ci.name AS connector_name,
                     (SELECT r.status FROM subscription_runs r WHERE r.subscription_id = s.subscription_id ORDER BY r.started_at DESC LIMIT 1) AS last_run_status,
                     (SELECT r.error_category FROM subscription_runs r WHERE r.subscription_id = s.subscription_id ORDER BY r.started_at DESC LIMIT 1) AS last_error_category
              FROM subscriptions s
              LEFT JOIN connector_instances ci ON ci.id = s.connector_instance_id
              WHERE s.tenant_id = $1 AND s.space_id = $2
              ORDER BY s.updated_at DESC
              LIMIT $3 OFFSET $4
            `,
            [subject.tenantId, scopeId, limit, offset],
          )
        : await app.db.query(
            `
              SELECT s.subscription_id, s.provider, s.status, s.last_run_at, s.updated_at, s.space_id, s.connector_instance_id,
                     ci.name AS connector_name,
                     (SELECT r.status FROM subscription_runs r WHERE r.subscription_id = s.subscription_id ORDER BY r.started_at DESC LIMIT 1) AS last_run_status,
                     (SELECT r.error_category FROM subscription_runs r WHERE r.subscription_id = s.subscription_id ORDER BY r.started_at DESC LIMIT 1) AS last_error_category
              FROM subscriptions s
              LEFT JOIN connector_instances ci ON ci.id = s.connector_instance_id
              WHERE s.tenant_id = $1
              ORDER BY s.updated_at DESC
              LIMIT $2 OFFSET $3
            `,
            [subject.tenantId, limit, offset],
          );
    const siem = await app.db.query(
      `
        SELECT d.id, d.name, d.enabled, d.updated_at,
               COALESCE((SELECT COUNT(1) FROM audit_siem_dlq q WHERE q.tenant_id = d.tenant_id AND q.destination_id = d.id), 0) AS dlq_count
        FROM audit_siem_destinations d
        WHERE d.tenant_id = $1
        ORDER BY d.updated_at DESC
        LIMIT $2 OFFSET $3
      `,
      [subject.tenantId, limit, offset],
    );

    const items: any[] = [];
    for (const r of oauth.rows as any[]) {
      items.push({
        integrationId: `oauth_grant:${r.grant_id}`,
        kind: "oauth_grant",
        name: `${String(r.provider)}@${String(r.connector_name ?? r.connector_instance_id)}`,
        status: String(r.status ?? ""),
        scopeType,
        scopeId,
        updatedAt: r.updated_at,
        links: { connectorInstanceId: String(r.connector_instance_id), provider: String(r.provider) },
      });
    }
    for (const r of subs.rows as any[]) {
      items.push({
        integrationId: `subscription:${r.subscription_id}`,
        kind: "subscription",
        name: `${String(r.provider)}${r.connector_name ? `@${String(r.connector_name)}` : ""}`,
        status: String(r.status ?? ""),
        lastRunAt: r.last_run_at,
        lastRunStatus: r.last_run_status ?? null,
        lastErrorCategory: r.last_error_category ?? null,
        scopeType,
        scopeId,
        updatedAt: r.updated_at,
        links: { subscriptionId: String(r.subscription_id), connectorInstanceId: r.connector_instance_id ? String(r.connector_instance_id) : null },
      });
    }
    for (const r of siem.rows as any[]) {
      items.push({
        integrationId: `siem_destination:${r.id}`,
        kind: "siem_destination",
        name: String(r.name ?? ""),
        status: r.enabled ? "enabled" : "disabled",
        dlqCount: Number(r.dlq_count ?? 0),
        scopeType: "tenant",
        scopeId: subject.tenantId,
        updatedAt: r.updated_at,
        links: { destinationId: String(r.id) },
      });
    }

    items.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    req.ctx.audit!.outputDigest = { count: items.length, scopeType, scopeId };
    return { scopeType, scopeId, items };
  });

  app.get("/governance/integrations/:integrationId", async (req, reply) => {
    const subject = req.ctx.subject!;
    const params = z.object({ integrationId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "changeset.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "changeset.read" });
    req.ctx.audit!.policyDecision = decision;

    const raw = params.integrationId;
    const idx = raw.indexOf(":");
    if (idx < 0) throw Errors.badRequest("integrationId 无效");
    const kind = raw.slice(0, idx);
    const id = raw.slice(idx + 1);

    if (kind === "subscription") {
      const sRes = await app.db.query(
        `
          SELECT s.*, ci.name AS connector_name
          FROM subscriptions s
          LEFT JOIN connector_instances ci ON ci.id = s.connector_instance_id
          WHERE s.tenant_id = $1 AND s.subscription_id = $2::uuid
          LIMIT 1
        `,
        [subject.tenantId, id],
      );
      if (!sRes.rowCount) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Integration 不存在", "en-US": "Integration not found" }, traceId: req.ctx.traceId });
      const rRes = await app.db.query(
        `
          SELECT *
          FROM subscription_runs
          WHERE tenant_id = $1 AND subscription_id = $2::uuid
          ORDER BY started_at DESC
          LIMIT 50
        `,
        [subject.tenantId, id],
      );
      return { kind, integrationId: raw, integration: sRes.rows[0], runs: rRes.rows };
    }
    if (kind === "oauth_grant") {
      const gRes = await app.db.query(
        `
          SELECT g.*, ci.name AS connector_name, ci.type_name AS connector_type
          FROM oauth_grants g
          JOIN connector_instances ci ON ci.id = g.connector_instance_id
          WHERE g.tenant_id = $1 AND g.grant_id = $2::uuid
          LIMIT 1
        `,
        [subject.tenantId, id],
      );
      if (!gRes.rowCount) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Integration 不存在", "en-US": "Integration not found" }, traceId: req.ctx.traceId });
      const g: any = gRes.rows[0];
      const sRes = await app.db.query(
        `
          SELECT *
          FROM oauth_states
          WHERE tenant_id = $1 AND connector_instance_id = $2::uuid AND provider = $3
          ORDER BY created_at DESC
          LIMIT 50
        `,
        [subject.tenantId, g.connector_instance_id, g.provider],
      );
      return { kind, integrationId: raw, integration: g, states: sRes.rows };
    }
    if (kind === "siem_destination") {
      const dRes = await app.db.query(`SELECT * FROM audit_siem_destinations WHERE tenant_id = $1 AND id = $2::uuid LIMIT 1`, [subject.tenantId, id]);
      if (!dRes.rowCount) return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "Integration 不存在", "en-US": "Integration not found" }, traceId: req.ctx.traceId });
      const dlq = await app.db.query(
        `
          SELECT id, event_id, event_ts, attempts, last_error_digest, created_at
          FROM audit_siem_dlq
          WHERE tenant_id = $1 AND destination_id = $2::uuid
          ORDER BY created_at DESC
          LIMIT 50
        `,
        [subject.tenantId, id],
      );
      const outbox = await app.db.query(
        `
          SELECT id, event_id, event_ts, attempts, next_attempt_at, last_error_digest, created_at, updated_at
          FROM audit_siem_outbox
          WHERE tenant_id = $1 AND destination_id = $2::uuid
          ORDER BY next_attempt_at ASC, event_ts ASC
          LIMIT 50
        `,
        [subject.tenantId, id],
      );
      return { kind, integrationId: raw, integration: dRes.rows[0], outbox: outbox.rows, dlq: dlq.rows };
    }
    throw Errors.badRequest("integrationId kind 不支持");
  });
};

