import { timingSafeEqual } from "node:crypto";

const TEXT_MAX = 4096;
const SECRET_MAX = 4096;
const BODY_MAX = 32 * 1024;
const TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]+$/;
const CHAT_PATTERN = /^(?:@[A-Za-z0-9_]{5,32}|-?\d{1,20})$/;
const TELEGRAM_ORIGIN = "https://api.telegram.org";

function envValue(name) {
  return (process.env[name] ?? "").trim();
}

function secretsMatch(provided, expected) {
  if (expected.length === 0 || provided.length === 0 || provided.length > SECRET_MAX) {
    return false;
  }

  const actual = Buffer.from(provided);
  const stored = Buffer.from(expected);
  if (actual.length !== stored.length) {
    timingSafeEqual(stored, stored);
    return false;
  }
  return timingSafeEqual(actual, stored);
}

function json(status, body, headers) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function isJsonContentType(value) {
  return /^application\/json\s*(?:;|$)/i.test(value.trim());
}

function readText(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "invalid_json" };
  }

  const { text } = payload;
  if (typeof text !== "string" || text.trim().length === 0) {
    return { error: "invalid_text" };
  }
  if (text.length > TEXT_MAX) {
    return { error: "text_too_long" };
  }
  return { text };
}

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return json(405, { ok: false, error: "method_not_allowed" }, { allow: "POST" });
    }

    const providedSecret = request.headers.get("x-relay-secret") ?? "";
    if (!secretsMatch(providedSecret, envValue("RELAY_SECRET"))) {
      return json(401, { ok: false, error: "unauthorized" });
    }

    const token = envValue("TELEGRAM_BOT_TOKEN");
    const chatId = envValue("TELEGRAM_CHAT_ID");
    if (!TOKEN_PATTERN.test(token) || !CHAT_PATTERN.test(chatId)) {
      return json(500, { ok: false, error: "not_configured" });
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (!isJsonContentType(contentType)) {
      return json(400, { ok: false, error: "invalid_json" });
    }

    const contentLength = request.headers.get("content-length");
    if (contentLength !== null) {
      const size = Number(contentLength);
      if (!Number.isFinite(size) || size > BODY_MAX) {
        return json(400, { ok: false, error: "invalid_json" });
      }
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json(400, { ok: false, error: "invalid_json" });
    }

    const message = readText(payload);
    if (message.error) {
      return json(400, { ok: false, error: message.error });
    }

    const url = new URL(`/bot${token}/sendMessage`, TELEGRAM_ORIGIN);
    if (
      url.origin !== TELEGRAM_ORIGIN ||
      url.pathname !== `/bot${token}/sendMessage` ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return json(500, { ok: false, error: "not_configured" });
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message.text }),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });

      let result = null;
      try {
        result = await response.json();
      } catch {
        result = null;
      }

      if (!response.ok || result?.ok !== true) {
        console.error("telegram sendMessage failed", response.status);
        return json(502, { ok: false, error: "telegram_rejected" });
      }

      return json(200, { ok: true });
    } catch {
      console.error("telegram sendMessage unreachable");
      return json(502, { ok: false, error: "telegram_unreachable" });
    }
  },
};
