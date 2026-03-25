const out = document.getElementById("out");

function send(kind, payload) {
  const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  window.parent.postMessage({ id, kind, payload }, "*");
  return id;
}

window.addEventListener("message", (ev) => {
  const d = ev.data;
  if (!d || typeof d !== "object") return;
  if (d.ok) out.textContent = JSON.stringify(d.body?.result ?? d.body ?? null);
  else out.textContent = `error ${d.status}: ${JSON.stringify(d.body ?? null)}`;
});

send("schema.effective", { entityName: "notes", schemaName: "core" });
