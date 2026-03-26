// IMAP Poll skill - polls mailbox for new messages (stub)
exports.execute = async function execute(req) {
  const crypto = require("node:crypto");
  const sha256Hex = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
  const sha256HexBytes = (b) => crypto.createHash("sha256").update(b).digest("hex");
  const uidNext = Number(req?.input?.uidNext ?? 1);
  const mailbox = String(req?.input?.mailbox ?? "INBOX");
  const isOversize = mailbox.toUpperCase().includes("OVERSIZE");
  const bodyContent = `mvp imap body uid=${uidNext}\n`;
  const attachmentContent = `mvp imap attachment uid=${uidNext}\n`;
  const oversizeBytes = isOversize ? Buffer.alloc(6 * 1024 * 1024, 0x61) : null;
  const attBytesLen = isOversize ? oversizeBytes.length : Buffer.byteLength(attachmentContent, "utf8");
  const attSha256 = isOversize ? sha256HexBytes(oversizeBytes) : sha256Hex(attachmentContent);
  return {
    uid: uidNext,
    internalDate: new Date().toISOString(),
    summary: { subject: `Test mail ${uidNext}` },
    body: {
      contentType: "text/plain; charset=utf-8",
      byteSize: Buffer.byteLength(bodyContent, "utf8"),
      sha256: sha256Hex(bodyContent),
    },
    bodyContent,
    attachments: [
      {
        fileName: "attachment.txt",
        contentType: "text/plain; charset=utf-8",
        byteSize: attBytesLen,
        sha256: attSha256,
      },
    ],
    attachmentContent,
    isOversize,
    watermarkAfter: { uidNext: uidNext + 1 },
  };
};
