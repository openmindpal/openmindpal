import fs from "node:fs/promises";

const last = JSON.parse(await fs.readFile("d:/trae/openslin/.tmp/wb-demo-last.json", "utf8"));
const wbKey = last.wbKey;
const url = `http://localhost:3000/api/workbenches/${encodeURIComponent(wbKey)}/bridge`;
const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: "openslin_token=admin", "x-user-locale": "zh-CN" },
  body: JSON.stringify({ id: "1", kind: "tools.invoke", payload: { toolRef: "tool.echo@1", input: { message: "x" } } }),
});
const txt = await res.text();
await fs.writeFile("d:/trae/openslin/.tmp/wb-demo-bridge-check.json", JSON.stringify({ status: res.status, body: txt }), "utf8");
