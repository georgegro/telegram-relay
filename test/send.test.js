import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, test } from "node:test";
import handler from "../api/send.js";

const TOKEN = "1:testtokenvalue";
const CHAT = "-1000000000000";
const EXTRA = "424242";
const SECRET = "test-relay-secret-value";

const prevEnv = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  TELEGRAM_EXTRA_CHAT_ID: process.env.TELEGRAM_EXTRA_CHAT_ID,
  RELAY_SECRET: process.env.RELAY_SECRET,
};
const realFetch = globalThis.fetch;

let calls;

function restoreEnv() {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function telegramOk() {
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.TELEGRAM_CHAT_ID = CHAT;
  delete process.env.TELEGRAM_EXTRA_CHAT_ID;
  process.env.RELAY_SECRET = SECRET;
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return telegramOk();
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  restoreEnv();
});

function send(body, { method = "POST", headers = {}, secret = SECRET } = {}) {
  const finalHeaders = {
    "content-type": "application/json",
    ...headers,
  };
  if (secret !== null) finalHeaders["x-relay-secret"] = secret;

  return handler.fetch(
    new Request("https://relay.example/api/send?secret=ignored", {
      method,
      headers: finalHeaders,
      body: method === "GET" || method === "HEAD" ? undefined : body,
    }),
  );
}

test("sends one plain sendMessage and returns ok", async () => {
  const response = await send(JSON.stringify({ text: " hello " }));
  const raw = await response.text();

  assert.equal(response.status, 200);
  assert.equal(raw, '{"ok":true}');
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    chat_id: CHAT,
    text: " hello ",
  });
  assert.equal(raw.includes(TOKEN), false);
  assert.equal(raw.includes(CHAT), false);
  assert.equal(raw.includes(SECRET), false);
});

test("rejects a missing, wrong, or unset secret before calling Telegram", async () => {
  const missing = await send(JSON.stringify({ text: "hi" }), { secret: null });
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { ok: false, error: "unauthorized" });

  const wrong = await send(JSON.stringify({ text: "hi" }), { secret: "nope" });
  assert.equal(wrong.status, 401);

  delete process.env.RELAY_SECRET;
  const unset = await send(JSON.stringify({ text: "hi" }), { secret: "" });
  assert.equal(unset.status, 401);

  delete process.env.TELEGRAM_BOT_TOKEN;
  const hidden = await send(JSON.stringify({ text: "hi" }), { secret: "wrong" });
  assert.equal(hidden.status, 401);
  assert.equal(calls.length, 0);
});

test("ignores the secret in the body and the query string", async () => {
  const response = await send(
    JSON.stringify({ text: "hi", secret: SECRET }),
    { secret: null },
  );
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test("trims env values and accepts a charset on the JSON content type", async () => {
  process.env.RELAY_SECRET = `  ${SECRET}\n`;
  process.env.TELEGRAM_BOT_TOKEN = ` ${TOKEN} `;
  process.env.TELEGRAM_CHAT_ID = ` ${CHAT} `;

  const response = await send(JSON.stringify({ text: "hi" }), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
});

test("returns not_configured only after the secret matches", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "not a token";
  const response = await send(JSON.stringify({ text: "hi" }));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, error: "not_configured" });
  assert.equal(calls.length, 0);

  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.TELEGRAM_CHAT_ID = "not a chat";
  const badChat = await send(JSON.stringify({ text: "hi" }));
  assert.equal(badChat.status, 500);
  assert.equal(calls.length, 0);
});

test("rejects bad requests", async () => {
  const cases = [
    ["{", "invalid_json"],
    [JSON.stringify(["hi"]), "invalid_json"],
    [JSON.stringify({ text: 1 }), "invalid_text"],
    [JSON.stringify({ text: "   " }), "invalid_text"],
    [JSON.stringify({}), "invalid_text"],
    [JSON.stringify({ text: "a".repeat(4097) }), "text_too_long"],
  ];

  for (const [body, error] of cases) {
    const response = await send(body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error });
  }

  const wrongType = await send(JSON.stringify({ text: "hi" }), {
    headers: { "content-type": "text/plain" },
  });
  assert.equal(wrongType.status, 400);
  assert.equal(calls.length, 0);
});

test("accepts a 4096 character message", async () => {
  const text = ` ${"a".repeat(4094)} `;
  assert.equal(text.length, 4096);
  const response = await send(JSON.stringify({ text }));
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(calls[0].init.body).text, text);
});

test("rejects non-POST methods", async () => {
  for (const method of ["GET", "PUT", "OPTIONS"]) {
    const response = await send(undefined, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    assert.deepEqual(await response.json(), { ok: false, error: "method_not_allowed" });
  }
  assert.equal(calls.length, 0);
});

test("hides Telegram error details", async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ok: false,
        description: `chat ${CHAT} token ${TOKEN}`,
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );

  const response = await send(JSON.stringify({ text: "hi" }));
  const raw = await response.text();
  assert.equal(response.status, 502);
  assert.equal(raw, '{"ok":false,"error":"telegram_rejected"}');
  assert.equal(raw.includes(TOKEN), false);
  assert.equal(raw.includes(CHAT), false);
});

test("omitted or default recipient stays on TELEGRAM_CHAT_ID", async () => {
  process.env.TELEGRAM_EXTRA_CHAT_ID = EXTRA;

  const omitted = await send(JSON.stringify({ text: "hi" }));
  assert.equal(omitted.status, 200);
  assert.deepEqual(JSON.parse(calls[0].init.body), { chat_id: CHAT, text: "hi" });

  const explicit = await send(JSON.stringify({ text: "hi", to: "default" }));
  assert.equal(explicit.status, 200);
  assert.deepEqual(JSON.parse(calls[1].init.body), { chat_id: CHAT, text: "hi" });

  delete process.env.TELEGRAM_EXTRA_CHAT_ID;
  calls.length = 0;
  const unset = await send(JSON.stringify({ text: "hi" }));
  assert.equal(unset.status, 200);
  assert.equal(JSON.parse(calls[0].init.body).chat_id, CHAT);

  const injected = await send(JSON.stringify({ text: "hi", chat_id: "999999" }));
  assert.equal(injected.status, 200);
  assert.equal(JSON.parse(calls[1].init.body).chat_id, CHAT);
});

test("sends to the extra recipient when to is extra", async () => {
  process.env.TELEGRAM_EXTRA_CHAT_ID = ` ${EXTRA} `;

  const response = await send(JSON.stringify({ text: "hi", to: "extra" }));
  const raw = await response.text();

  assert.equal(response.status, 200);
  assert.equal(raw, '{"ok":true}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    chat_id: EXTRA,
    text: "hi",
  });
  assert.equal(raw.includes(EXTRA), false);
  assert.equal(raw.includes(TOKEN), false);

  process.env.TELEGRAM_EXTRA_CHAT_ID = "-100424242";
  const negative = await send(JSON.stringify({ text: "hi", to: "extra" }));
  assert.equal(negative.status, 200);
  assert.equal(JSON.parse(calls[1].init.body).chat_id, "-100424242");
});

test("rejects an unknown recipient", async () => {
  process.env.TELEGRAM_EXTRA_CHAT_ID = EXTRA;

  for (const to of ["other", "group", "", "Extra", null, 1]) {
    const response = await send(JSON.stringify({ text: "hi", to }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: "invalid_recipient" });
  }
  assert.equal(calls.length, 0);
});

test("rejects extra when TELEGRAM_EXTRA_CHAT_ID is unset or invalid", async () => {
  const unset = await send(JSON.stringify({ text: "hi", to: "extra" }));
  assert.equal(unset.status, 400);
  assert.deepEqual(await unset.json(), { ok: false, error: "recipient_not_configured" });

  for (const value of ["", "   ", "@channelname", "not-a-chat", "12ab", "+424242", "1".repeat(21)]) {
    process.env.TELEGRAM_EXTRA_CHAT_ID = value;
    const response = await send(JSON.stringify({ text: "hi", to: "extra" }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: "recipient_not_configured" });
  }

  process.env.TELEGRAM_EXTRA_CHAT_ID = "not-a-chat";
  const fallback = await send(JSON.stringify({ text: "still default" }));
  assert.equal(fallback.status, 200);
  assert.equal(JSON.parse(calls[0].init.body).chat_id, CHAT);
  assert.equal(calls.length, 1);
});

test("rejects a raw chat id in to", async () => {
  process.env.TELEGRAM_EXTRA_CHAT_ID = EXTRA;

  for (const to of [EXTRA, CHAT, "123456789", "-1001234567890", "@someone"]) {
    const response = await send(JSON.stringify({ text: "hi", to }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: "invalid_recipient" });
  }
  assert.equal(calls.length, 0);
});

test("reports an unreachable Bot API without echoing the failure", async () => {
  globalThis.fetch = async () => {
    throw new Error(`boom ${TOKEN} ${CHAT}`);
  };

  const response = await send(JSON.stringify({ text: "hi" }));
  const raw = await response.text();
  assert.equal(response.status, 502);
  assert.equal(raw, '{"ok":false,"error":"telegram_unreachable"}');
  assert.equal(raw.includes(TOKEN), false);
});

test("docs and examples contain no tokens or chat ids", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const example = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  const source = await readFile(new URL("../api/send.js", import.meta.url), "utf8");
  const docs = `${readme}\n${example}`;

  assert.match(docs, /TELEGRAM_BOT_TOKEN/);
  assert.match(docs, /TELEGRAM_CHAT_ID/);
  assert.match(docs, /TELEGRAM_EXTRA_CHAT_ID/);
  assert.match(docs, /RELAY_SECRET/);
  assert.match(docs, /X-Relay-Secret/);
  assert.match(readme, /press Start/);
  assert.match(readme, /numeric/);
  assert.match(readme, /@username/);
  assert.doesNotMatch(docs, /\d{6,}:[A-Za-z0-9_-]{10,}/);
  assert.doesNotMatch(docs, /api\.telegram\.org\/bot(?!<)/);
  assert.doesNotMatch(source, /\d{6,}:[A-Za-z0-9_-]{10,}/);
});
