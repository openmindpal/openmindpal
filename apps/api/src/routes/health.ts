import type { FastifyPluginAsync } from "fastify";
import { getBuiltinSkills, validateSkillDependencies } from "../lib/skillPlugin";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async (req) => {
    return {
      ok: true,
      traceId: req.ctx.traceId,
      locale: req.ctx.locale,
    };
  });

  app.get("/healthz", async (req, reply) => {
    let dbOk = false;
    let redisOk = false;
    try {
      await app.db.query("SELECT 1");
      dbOk = true;
    } catch {
    }
    try {
      const pong = await app.redis.ping();
      redisOk = String(pong).toUpperCase() === "PONG";
    } catch {
    }
    const ok = dbOk && redisOk;
    if (!ok) reply.status(503);

    // Skill 注册完整性检查
    const skills = getBuiltinSkills();
    const skillCount = skills.size;
    const depErrors = validateSkillDependencies();
    const skillsOk = depErrors.length === 0 && skillCount > 0;

    const allOk = ok && skillsOk;
    if (!allOk) reply.status(503);
    return {
      ok: allOk,
      deps: {
        db: dbOk ? "ok" : "down",
        redis: redisOk ? "ok" : "down",
        skills: skillsOk ? "ok" : "degraded",
      },
      skillCount,
      skillDepErrors: depErrors.length > 0 ? depErrors : undefined,
      version: process.env.npm_package_version ?? null,
      traceId: req.ctx.traceId,
    };
  });
};
