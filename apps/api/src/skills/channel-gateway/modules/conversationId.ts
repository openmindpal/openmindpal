import crypto from "node:crypto";

function sha256_24(s: string) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 24);
}

export function channelConversationId(params: { provider: string; workspaceId: string; channelChatId: string; threadId?: string | null }) {
  const input = `${params.provider}|${params.workspaceId}|${params.channelChatId}|${params.threadId ?? ""}`;
  const h = sha256_24(input);
  const p = params.provider.replaceAll(":", "_").replaceAll("/", "_");
  return `ch:${p}:${h}`;
}

