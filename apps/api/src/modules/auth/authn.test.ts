import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { authenticate } from "./authn";

function signToken(secret: string, payload: any) {
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sigPart = crypto.createHmac("sha256", secret).update(payloadPart, "utf8").digest("base64url");
  return `${payloadPart}.${sigPart}`;
}

describe("authn", () => {
  it("dev 模式：解析 subjectId@spaceId", async () => {
    const prevMode = process.env.AUTHN_MODE;
    delete process.env.AUTHN_MODE;
    try {
      const s = await authenticate({ authorization: "Bearer u1@space_other" });
      expect(s?.subjectId).toBe("u1");
      expect(s?.tenantId).toBe("tenant_dev");
      expect(s?.spaceId).toBe("space_other");
    } finally {
      if (prevMode === undefined) delete process.env.AUTHN_MODE;
      else process.env.AUTHN_MODE = prevMode;
    }
  });

  it("hmac 模式：有效 token 放行", async () => {
    const prevMode = process.env.AUTHN_MODE;
    const prevSecret = process.env.AUTHN_HMAC_SECRET;
    process.env.AUTHN_MODE = "hmac";
    process.env.AUTHN_HMAC_SECRET = "s";
    try {
      const token = signToken("s", { tenantId: "t1", subjectId: "u1", spaceId: "s1", exp: Math.floor(Date.now() / 1000) + 60 });
      const s = await authenticate({ authorization: `Bearer ${token}` });
      expect(s).toEqual({ tenantId: "t1", subjectId: "u1", spaceId: "s1" });
    } finally {
      if (prevMode === undefined) delete process.env.AUTHN_MODE;
      else process.env.AUTHN_MODE = prevMode;
      if (prevSecret === undefined) delete process.env.AUTHN_HMAC_SECRET;
      else process.env.AUTHN_HMAC_SECRET = prevSecret;
    }
  });

  it("hmac 模式：过期 token 拒绝", async () => {
    const prevMode = process.env.AUTHN_MODE;
    const prevSecret = process.env.AUTHN_HMAC_SECRET;
    process.env.AUTHN_MODE = "hmac";
    process.env.AUTHN_HMAC_SECRET = "s";
    try {
      const token = signToken("s", { tenantId: "t1", subjectId: "u1", spaceId: "s1", exp: Math.floor(Date.now() / 1000) - 1 });
      const s = await authenticate({ authorization: `Bearer ${token}` });
      expect(s).toBeNull();
    } finally {
      if (prevMode === undefined) delete process.env.AUTHN_MODE;
      else process.env.AUTHN_MODE = prevMode;
      if (prevSecret === undefined) delete process.env.AUTHN_HMAC_SECRET;
      else process.env.AUTHN_HMAC_SECRET = prevSecret;
    }
  });

  it("hmac 模式：篡改签名拒绝", async () => {
    const prevMode = process.env.AUTHN_MODE;
    const prevSecret = process.env.AUTHN_HMAC_SECRET;
    process.env.AUTHN_MODE = "hmac";
    process.env.AUTHN_HMAC_SECRET = "s";
    try {
      const payloadPart = Buffer.from(
        JSON.stringify({ tenantId: "t1", subjectId: "u1", spaceId: "s1", exp: Math.floor(Date.now() / 1000) + 60 }),
        "utf8",
      ).toString("base64url");
      const token = `${payloadPart}.AAAA`;
      const s = await authenticate({ authorization: `Bearer ${token}` });
      expect(s).toBeNull();
    } finally {
      if (prevMode === undefined) delete process.env.AUTHN_MODE;
      else process.env.AUTHN_MODE = prevMode;
      if (prevSecret === undefined) delete process.env.AUTHN_HMAC_SECRET;
      else process.env.AUTHN_HMAC_SECRET = prevSecret;
    }
  });
});
