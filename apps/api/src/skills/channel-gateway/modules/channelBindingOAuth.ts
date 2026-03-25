/**
 * channelBindingOAuth.ts
 *
 * 各 IM 平台 OAuth 授权 URL 构建 & 回调中 code → 用户身份解析
 * 支持飞书 / 钉钉 / 企业微信 / Slack / Discord，可扩展。
 */

import { getFeishuTenantAccessToken } from "./feishu";

// ─── 公共工具 ─────────────────────────────────────────────────────────────────

async function fetchJson(url: string, init: RequestInit) {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => null);
  return { res, json };
}

export type ChannelBindingCredentials = {
  /** 飞书 / 钉钉 / 企业微信 appId */
  appId: string;
  /** 飞书 / 钉钉 / 企业微信 appSecret */
  appSecret: string;
  /** Slack Bot Token */
  slackBotToken?: string;
  /** Slack Client ID */
  slackClientId?: string;
  /** Slack Client Secret */
  slackClientSecret?: string;
  /** Discord Client ID */
  discordClientId?: string;
  /** Discord Client Secret */
  discordClientSecret?: string;
  /** 飞书 base URL (default https://open.feishu.cn) */
  feishuBaseUrl?: string;
};

// ─── 授权 URL 构建 ───────────────────────────────────────────────────────────

export function buildChannelBindingAuthorizeUrl(params: {
  provider: string;
  credentials: ChannelBindingCredentials;
  redirectUri: string;
  state: string;
}): string {
  const { provider, credentials, redirectUri, state } = params;

  switch (provider) {
    case "feishu": {
      const base = credentials.feishuBaseUrl || "https://open.feishu.cn";
      const u = new URL(`${base}/open-apis/authen/v1/authorize`);
      u.searchParams.set("app_id", credentials.appId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("state", state);
      return u.toString();
    }
    case "dingtalk": {
      const u = new URL("https://login.dingtalk.com/oauth2/auth");
      u.searchParams.set("client_id", credentials.appId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("state", state);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", "openid");
      u.searchParams.set("prompt", "consent");
      return u.toString();
    }
    case "wecom": {
      const u = new URL("https://open.work.weixin.qq.com/wwopen/sso/qrConnect");
      u.searchParams.set("appid", credentials.appId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("state", state);
      return u.toString();
    }
    case "slack": {
      const clientId = credentials.slackClientId || credentials.appId;
      const u = new URL("https://slack.com/oauth/v2/authorize");
      u.searchParams.set("client_id", clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("state", state);
      u.searchParams.set("scope", "");
      u.searchParams.set("user_scope", "identity.basic");
      return u.toString();
    }
    case "discord": {
      const clientId = credentials.discordClientId || credentials.appId;
      const u = new URL("https://discord.com/oauth2/authorize");
      u.searchParams.set("client_id", clientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("state", state);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", "identify");
      return u.toString();
    }
    default:
      throw new Error(`unsupported_provider:${provider}`);
  }
}

// ─── Code → 用户身份 ─────────────────────────────────────────────────────────

export type ChannelUserIdentity = {
  channelUserId: string;
  displayName: string;
  avatarUrl?: string;
  extra?: Record<string, unknown>;
};

/**
 * 用 OAuth authorization code 换取渠道用户身份。
 * 每个平台的 token/userinfo API 不同，此函数统一封装。
 */
export async function exchangeCodeForChannelUser(params: {
  provider: string;
  code: string;
  credentials: ChannelBindingCredentials;
  redirectUri: string;
}): Promise<ChannelUserIdentity> {
  const { provider, code, credentials, redirectUri } = params;

  switch (provider) {
    case "feishu":
      return exchangeFeishu({ code, credentials });
    case "dingtalk":
      return exchangeDingtalk({ code, credentials });
    case "wecom":
      return exchangeWecom({ code, credentials });
    case "slack":
      return exchangeSlack({ code, credentials, redirectUri });
    case "discord":
      return exchangeDiscord({ code, credentials, redirectUri });
    default:
      throw new Error(`unsupported_provider:${provider}`);
  }
}

// ─── 飞书 ────────────────────────────────────────────────────────────────────

async function exchangeFeishu(params: {
  code: string;
  credentials: ChannelBindingCredentials;
}): Promise<ChannelUserIdentity> {
  const base = params.credentials.feishuBaseUrl || "https://open.feishu.cn";
  const accessToken = await getFeishuTenantAccessToken({
    baseUrl: base,
    appId: params.credentials.appId,
    appSecret: params.credentials.appSecret,
  });

  // 使用 user_access_token 获取用户身份
  const { json } = await fetchJson(`${base}/open-apis/authen/v1/oidc/access_token`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: params.code,
    }),
  });

  const data = json?.data;
  if (!data) {
    console.error("[channelBindingOAuth] 飞书 code 换取失败:", JSON.stringify(json));
    throw new Error("feishu_exchange_failed");
  }

  const openId = String(data.open_id ?? "");
  const name = String(data.name ?? data.en_name ?? "");
  const avatar = typeof data.avatar_url === "string" ? data.avatar_url : undefined;

  if (!openId) {
    console.error("[channelBindingOAuth] 飞书返回缺少 open_id:", JSON.stringify(data));
    throw new Error("feishu_missing_open_id");
  }

  return { channelUserId: openId, displayName: name, avatarUrl: avatar, extra: { userId: data.user_id } };
}

// ─── 钉钉 ────────────────────────────────────────────────────────────────────

async function exchangeDingtalk(params: {
  code: string;
  credentials: ChannelBindingCredentials;
}): Promise<ChannelUserIdentity> {
  // Step 1: code → userAccessToken
  const { json: tokenJson } = await fetchJson("https://api.dingtalk.com/v1.0/oauth2/userAccessToken", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: params.credentials.appId,
      clientSecret: params.credentials.appSecret,
      code: params.code,
      grantType: "authorization_code",
    }),
  });

  const userAccessToken = String(tokenJson?.accessToken ?? "");
  if (!userAccessToken) {
    console.error("[channelBindingOAuth] 钉钉 token 交换失败:", JSON.stringify(tokenJson));
    throw new Error("dingtalk_exchange_failed");
  }

  // Step 2: userAccessToken → userinfo
  const { json: userJson } = await fetchJson("https://api.dingtalk.com/v1.0/contact/users/me", {
    method: "GET",
    headers: { "x-acs-dingtalk-access-token": userAccessToken },
  });

  const openId = String(userJson?.openId ?? userJson?.unionId ?? "");
  const name = String(userJson?.nick ?? "");
  const avatar = typeof userJson?.avatarUrl === "string" ? userJson.avatarUrl : undefined;

  if (!openId) {
    console.error("[channelBindingOAuth] 钉钉返回缺少 openId:", JSON.stringify(userJson));
    throw new Error("dingtalk_missing_open_id");
  }

  return { channelUserId: openId, displayName: name, avatarUrl: avatar, extra: { unionId: userJson?.unionId } };
}

// ─── 企业微信 ────────────────────────────────────────────────────────────────

async function exchangeWecom(params: {
  code: string;
  credentials: ChannelBindingCredentials;
}): Promise<ChannelUserIdentity> {
  // Step 1: 获取 access_token
  const { json: tokenJson } = await fetchJson(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(params.credentials.appId)}&corpsecret=${encodeURIComponent(params.credentials.appSecret)}`,
    { method: "GET" },
  );

  const accessToken = String(tokenJson?.access_token ?? "");
  if (!accessToken) {
    console.error("[channelBindingOAuth] 企业微信 access_token 获取失败:", JSON.stringify(tokenJson));
    throw new Error("wecom_token_failed");
  }

  // Step 2: code → userId
  const { json: userJson } = await fetchJson(
    `https://qyapi.weixin.qq.com/cgi-bin/user/getuserinfo?access_token=${encodeURIComponent(accessToken)}&code=${encodeURIComponent(params.code)}`,
    { method: "GET" },
  );

  const userId = String(userJson?.UserId ?? userJson?.userid ?? userJson?.OpenId ?? "");
  if (!userId) {
    console.error("[channelBindingOAuth] 企业微信返回缺少 UserId:", JSON.stringify(userJson));
    throw new Error("wecom_missing_user_id");
  }

  return { channelUserId: userId, displayName: userId, extra: { deviceId: userJson?.DeviceId } };
}

// ─── Slack ───────────────────────────────────────────────────────────────────

async function exchangeSlack(params: {
  code: string;
  credentials: ChannelBindingCredentials;
  redirectUri: string;
}): Promise<ChannelUserIdentity> {
  const clientId = params.credentials.slackClientId || params.credentials.appId;
  const clientSecret = params.credentials.slackClientSecret || params.credentials.appSecret;

  const { json } = await fetchJson("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
    }).toString(),
  });

  const userId = String(json?.authed_user?.id ?? "");
  if (!userId) {
    console.error("[channelBindingOAuth] Slack 返回缺少 user id:", JSON.stringify(json));
    throw new Error("slack_missing_user_id");
  }

  return { channelUserId: userId, displayName: userId, extra: { teamId: json?.team?.id } };
}

// ─── Discord ─────────────────────────────────────────────────────────────────

async function exchangeDiscord(params: {
  code: string;
  credentials: ChannelBindingCredentials;
  redirectUri: string;
}): Promise<ChannelUserIdentity> {
  const clientId = params.credentials.discordClientId || params.credentials.appId;
  const clientSecret = params.credentials.discordClientSecret || params.credentials.appSecret;

  const { json: tokenJson } = await fetchJson("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });

  const accessToken = String(tokenJson?.access_token ?? "");
  if (!accessToken) {
    console.error("[channelBindingOAuth] Discord token 交换失败:", JSON.stringify(tokenJson));
    throw new Error("discord_exchange_failed");
  }

  const { json: userJson } = await fetchJson("https://discord.com/api/users/@me", {
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}` },
  });

  const userId = String(userJson?.id ?? "");
  if (!userId) {
    console.error("[channelBindingOAuth] Discord 返回缺少 user id:", JSON.stringify(userJson));
    throw new Error("discord_missing_user_id");
  }

  const displayName = String(userJson?.username ?? "");
  const avatar = userJson?.avatar ? `https://cdn.discordapp.com/avatars/${userId}/${userJson.avatar}.png` : undefined;

  return { channelUserId: userId, displayName, avatarUrl: avatar };
}

// ─── 凭据解析工具 ─────────────────────────────────────────────────────────────

/**
 * 从 webhookConfig 的 secretPayload / providerConfig / 环境变量中提取绑定所需凭据
 */
export function resolveBindingCredentials(params: {
  provider: string;
  secretPayload: Record<string, unknown>;
  providerConfig: Record<string, unknown>;
}): ChannelBindingCredentials {
  const sp = params.secretPayload;
  const pc = params.providerConfig;
  const pick = (key: string) => {
    const v = sp[key];
    return typeof v === "string" ? v : "";
  };
  const pickEnv = (envKeyField: string) => {
    const envKey = typeof pc[envKeyField] === "string" ? String(pc[envKeyField]) : "";
    return envKey ? String(process.env[envKey] ?? "") : "";
  };

  return {
    appId: pickEnv("appIdEnvKey") || pick("appId"),
    appSecret: pickEnv("appSecretEnvKey") || pick("appSecret"),
    slackBotToken: pick("slackBotToken"),
    slackClientId: pick("slackClientId") || pickEnv("slackClientIdEnvKey"),
    slackClientSecret: pick("slackClientSecret") || pickEnv("slackClientSecretEnvKey"),
    discordClientId: pick("discordClientId") || pickEnv("discordClientIdEnvKey"),
    discordClientSecret: pick("discordClientSecret") || pickEnv("discordClientSecretEnvKey"),
    feishuBaseUrl: String(process.env.FEISHU_BASE_URL ?? "https://open.feishu.cn"),
  };
}
