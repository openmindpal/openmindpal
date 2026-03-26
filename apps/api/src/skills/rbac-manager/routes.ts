/**
 * RBAC Manager Routes
 *
 * 提供权限管理的对话式 API 路由
 */
import type { FastifyPluginAsync } from "fastify";

export const rbacManagerRoutes: FastifyPluginAsync = async (app) => {
  // 此 skill 主要通过工具定义提供对话式能力
  // 实际的 RBAC 操作通过现有的 /rbac 路由完成
  // 这里提供一个简单的信息端点

  app.get("/rbac-manager/info", async () => {
    return {
      name: "rbac.manager",
      version: "1.0.0",
      description: "RBAC Manager - 提供权限管理的对话式管理能力",
      supportedProviders: [
        { id: "role", name: "角色管理", actions: ["list", "create", "delete"] },
        { id: "permission", name: "权限管理", actions: ["list", "grant", "revoke"] },
        { id: "binding", name: "角色绑定", actions: ["list", "create", "delete"] },
        { id: "policy", name: "访问策略", actions: ["list", "create"] },
      ],
    };
  });
};
