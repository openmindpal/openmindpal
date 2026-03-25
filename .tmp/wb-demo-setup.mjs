import fs from "node:fs/promises";

const base = "http://localhost:3001";
const wbKey = `ops.dashboard.demo.${Math.random().toString(16).slice(2, 10)}`;
const common = { authorization: "Bearer admin", "x-tenant-id": "tenant_dev", "x-space-id": "space_dev" };

async function json(url, method, body, extraHeaders = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...common, ...extraHeaders, "content-type": "application/json", "x-trace-id": "t-wb-demo" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let data = null;
  try {
    data = JSON.parse(txt);
  } catch {
    data = txt;
  }
  if (!res.ok) throw new Error(`${method} ${url} ${res.status} ${txt}`);
  return data;
}

await json("/workbenches", "POST", { workbenchKey: wbKey });
const manifest = {
  apiVersion: "workbench.openslin/v1",
  workbenchKey: wbKey,
  entrypoint: { type: "iframe", assetPath: "index.html" },
  capabilities: { dataBindings: [{ kind: "schema.effective" }, { kind: "entities.query" }], actionBindings: [] },
};
await json(`/workbenches/${encodeURIComponent(wbKey)}/draft`, "POST", { artifactRef: "d:/trae/openslin/.tmp/workbench-demo", manifest });

const cs = await json("/governance/changesets", "POST", { title: `publish ${wbKey}`, scope: "space" });
const csId = cs.changeset.id;
await json(`/governance/changesets/${encodeURIComponent(csId)}/items`, "POST", { kind: "workbench.plugin.publish", workbenchKey: wbKey });
await fetch(base + `/governance/changesets/${encodeURIComponent(csId)}/submit`, { method: "POST", headers: { ...common, "x-trace-id": "t-wb-demo-submit" } });
await fetch(base + `/governance/changesets/${encodeURIComponent(csId)}/approve`, { method: "POST", headers: { ...common, "x-trace-id": "t-wb-demo-approve1" } });
await fetch(base + `/governance/changesets/${encodeURIComponent(csId)}/approve`, {
  method: "POST",
  headers: { authorization: "Bearer approver", "x-tenant-id": "tenant_dev", "x-space-id": "space_dev", "x-trace-id": "t-wb-demo-approve2" },
});
await fetch(base + `/governance/changesets/${encodeURIComponent(csId)}/release?mode=full`, { method: "POST", headers: { ...common, "x-trace-id": "t-wb-demo-release" } });

await fs.writeFile("d:/trae/openslin/.tmp/wb-demo-last.json", JSON.stringify({ wbKey, csId }), "utf8");
console.log(JSON.stringify({ wbKey, csId }));
