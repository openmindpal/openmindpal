export type PairResponse = { deviceId: string; deviceToken: string };

export async function apiPostJson<T>(params: { apiBase: string; path: string; token?: string; body: any }) {
  const res = await fetch(params.apiBase.replace(/\/+$/, "") + params.path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(params.token ? { authorization: `Device ${params.token}` } : {}),
    },
    body: JSON.stringify(params.body ?? {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, json: json as T };
}

export async function apiGetJson<T>(params: { apiBase: string; path: string; token: string }) {
  const res = await fetch(params.apiBase.replace(/\/+$/, "") + params.path, {
    method: "GET",
    headers: { authorization: `Device ${params.token}` },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, json: json as T };
}

