import type { FastifyReply, FastifyRequest } from "fastify";
import { Errors } from "../../../lib/errors";
import { handleFeishuEvents } from "./providerFeishu";
import { handleSlackEvents } from "./providerSlack";
import { handleDiscordInteractions } from "./providerDiscord";

export type ChannelProviderAdapter = {
  provider: string;
  handle: (ctx: { app: any; req: FastifyRequest; reply: FastifyReply }) => Promise<any>;
};

const registry: Record<string, ChannelProviderAdapter> = {
  feishu: { provider: "feishu", handle: handleFeishuEvents },
  slack: { provider: "slack", handle: handleSlackEvents },
  discord: { provider: "discord", handle: handleDiscordInteractions },
};

export function getChannelProviderAdapter(provider: string) {
  const key = String(provider ?? "").trim();
  const a = registry[key];
  if (!a) throw Errors.badRequest("未知 provider");
  return a;
}
