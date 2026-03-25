import fs from "node:fs/promises";

const last = JSON.parse(await fs.readFile("d:/trae/openslin/.tmp/wb-demo-last.json", "utf8"));
const wbKey = last.wbKey;
const url = `http://localhost:3000/w-assets/${encodeURIComponent(wbKey)}/index.html`;
const res = await fetch(url, { headers: { cookie: "openslin_token=admin", "x-user-locale": "zh-CN" } });
const csp = res.headers.get("content-security-policy") ?? "";
const out = { status: res.status, csp, contentType: res.headers.get("content-type") ?? "" };
await fs.writeFile("d:/trae/openslin/.tmp/wb-demo-check.json", JSON.stringify(out), "utf8");
