type TenantToken = { token: string; expiresAtSec: number };

const tokenCache = new Map<string, TenantToken>();

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

async function fetchJson(url: string, init: RequestInit) {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => null);
  return { res, json };
}

async function sleep(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function getFeishuTenantAccessToken(params: { baseUrl: string; appId: string; appSecret: string }) {
  const key = `${params.baseUrl}::${params.appId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAtSec - 30 > nowSec()) return cached.token;

  const { res, json } = await fetchJson(`${params.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: params.appId, app_secret: params.appSecret }),
  });
  if (!res.ok) throw new Error(`feishu_token_http_${res.status}`);
  const code = typeof json?.code === "number" ? json.code : -1;
  if (code !== 0) throw new Error(`feishu_token_code_${code}`);
  const token = String(json?.tenant_access_token ?? "");
  const expire = typeof json?.expire === "number" ? json.expire : 0;
  if (!token || !expire) throw new Error("feishu_token_invalid");
  tokenCache.set(key, { token, expiresAtSec: nowSec() + expire });
  return token;
}

export async function feishuSendTextToChat(params: { baseUrl: string; tenantAccessToken: string; chatId: string; text: string }) {
  const { res, json } = await fetchJson(`${params.baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.tenantAccessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      receive_id: params.chatId,
      msg_type: "text",
      content: JSON.stringify({ text: params.text }),
    }),
  });
  if (!res.ok) throw new Error(`feishu_send_http_${res.status}`);
  const code = typeof json?.code === "number" ? json.code : -1;
  if (code !== 0) throw new Error(`feishu_send_code_${code}`);
  return json;
}

export async function feishuSendTextToChatWithRetry(params: {
  baseUrl: string;
  tenantAccessToken: string;
  chatId: string;
  text: string;
  maxAttempts: number;
  backoffMsBase: number;
}) {
  const maxAttempts = Math.max(1, Math.min(5, Number(params.maxAttempts || 1)));
  const backoffMsBase = Math.max(0, Math.min(2000, Number(params.backoffMsBase || 0)));
  let lastErr: any = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { res, json } = await fetchJson(`${params.baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${params.tenantAccessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          receive_id: params.chatId,
          msg_type: "text",
          content: JSON.stringify({ text: params.text }),
        }),
      });
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < maxAttempts) {
          if (backoffMsBase) await sleep(backoffMsBase * attempt);
          continue;
        }
        throw new Error(`feishu_send_http_${res.status}`);
      }
      const code = typeof json?.code === "number" ? json.code : -1;
      if (code !== 0) throw new Error(`feishu_send_code_${code}`);
      return json;
    } catch (e: any) {
      lastErr = e;
      if (attempt >= maxAttempts) throw lastErr;
      if (backoffMsBase) await sleep(backoffMsBase * attempt);
    }
  }
  throw lastErr ?? new Error("feishu_send_failed");
}
