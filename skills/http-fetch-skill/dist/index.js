// HTTP Fetch skill - fetches URL content
exports.execute = async function execute(req) {
  const url = String(req?.input?.url ?? "");
  if (!url) return { status: 400, textLen: 0 };
  try {
    const res = await fetch(url, { method: req?.input?.method ?? "GET" });
    const body = await res.text();
    return { status: res.status, textLen: typeof body === "string" ? body.length : 0 };
  } catch (e) {
    // 将 policy_violation 错误向上冒泡，而不是捕获
    if (e?.message?.startsWith?.("policy_violation:")) throw e;
    return { status: 500, textLen: 0 };
  }
};
