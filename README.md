# Telegram outbound relay

One Vercel serverless function. `POST /api/send` checks a shared secret, then sends the JSON `text` field to one pre-approved Telegram chat with Bot API `sendMessage`.

The function does not store messages, register a webhook, or read chats.

## Endpoint

`POST /api/send`

The site root is not a page. A 404 on `/` means the deployment is up and the route to call is `/api/send`.

```http
Content-Type: application/json
X-Relay-Secret: <RELAY_SECRET>
```

```json
{"text":"<message>"}
```

`text` is plain text, from 1 to 4096 characters. The function reads the secret only from the `X-Relay-Secret` header. A secret in the JSON body or the query string is ignored.

`to` is optional. Omit it, or set `"default"`, to send to `TELEGRAM_CHAT_ID`. Set `"extra"` to send to the extra recipient in `TELEGRAM_EXTRA_CHAT_ID`. Any other value is rejected, including a raw chat id.

```json
{"text":"<message>","to":"extra"}
```

Success is HTTP 200:

```json
{"ok":true}
```

Every failure is HTTP 4xx or 5xx:

```json
{"ok":false,"error":"<code>"}
```

| Status | `error` | Meaning |
| --- | --- | --- |
| 401 | `unauthorized` | The header is missing or wrong, or `RELAY_SECRET` is unset |
| 400 | `invalid_json` | The body is not a JSON object |
| 400 | `invalid_text` | `text` is missing, not a string, or blank |
| 400 | `text_too_long` | `text` is longer than 4096 characters |
| 400 | `invalid_recipient` | `to` is present and is not `default` or `extra` |
| 400 | `recipient_not_configured` | `to` is `extra`, and `TELEGRAM_EXTRA_CHAT_ID` is unset or not a numeric chat id |
| 405 | `method_not_allowed` | The request is not `POST` |
| 500 | `not_configured` | The secret matched, and the bot token or `TELEGRAM_CHAT_ID` is missing or malformed |
| 502 | `telegram_rejected` | Telegram refused `sendMessage` |
| 502 | `telegram_unreachable` | The Bot API could not be reached |

Responses are `Cache-Control: no-store`. Upstream Telegram details are not returned.

## Environment variables

Set these in Vercel. Leave them out of git. `.env.example` is intentionally empty.

| Name | What to put there |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Chat that should receive messages |
| `TELEGRAM_EXTRA_CHAT_ID` | Optional numeric chat id for the extra recipient |
| `RELAY_SECRET` | Long random string callers send in `X-Relay-Secret` |

Surrounding whitespace on the Vercel values is ignored. Send the secret itself with no extra spaces.

**`TELEGRAM_BOT_TOKEN`.** In Telegram, open @BotFather, send `/newbot`, and copy the token it shows. That token controls the bot. Store it only in Vercel.

**`TELEGRAM_CHAT_ID`.** The bot has to be allowed to post there. In a private chat, open the bot and press Start. In a group, add the bot. In a channel, add the bot as an admin.

Send a message in that chat, then from your own machine read the id once:

```bash
curl -sS "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates"
```

Use `message.chat.id` from the JSON. A public channel can use its `@username` instead. This project never calls `getUpdates`.

**`TELEGRAM_EXTRA_CHAT_ID`.** Optional. When a request sets `"to":"extra"`, the relay sends to this chat instead of `TELEGRAM_CHAT_ID`. Leave it unset if you only need the default chat; those sends keep working. The extra recipient must open the bot and press Start before the bot can message them. Use the numeric `message.chat.id`. An `@username` is not accepted here.

**`RELAY_SECRET`.** Generate a long random string and keep the same value in Vercel and in the caller:

```bash
openssl rand -base64 32
```

Anyone with this value can post as the bot through the relay. To rotate it, change the Vercel variable, redeploy, and update callers.

## Deploy on your Vercel account

Deploy this from the Vercel account that should own it. No extra platform access is required.

1. Push this directory to a Git repository you control (GitHub, GitLab, or Bitbucket).
2. In Vercel, choose **Add New… → Project** and import that repository.
3. Leave **Root Directory** as `./`. Set **Framework Preset** to **Other**. If Vercel fills in a build command or output directory, clear both. The default install command is fine; there are no packages.
4. Use the **Node.js 22.x** runtime. `package.json` already requests it.
5. Add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `RELAY_SECRET`. `TELEGRAM_EXTRA_CHAT_ID` is optional. Apply them to **Production**. Also apply them to **Preview** if preview URLs should be able to send.
6. Deploy.

The live endpoint is:

```text
https://<your-project>.vercel.app/api/send
```

If you create or edit a variable after the first deployment, redeploy (**Deployments** → latest deployment → **Redeploy**) so the function sees the new values.

From this directory, while logged into your own Vercel account, the CLI equivalent is `npx vercel env add TELEGRAM_BOT_TOKEN` (and the same for the other names), then `npx vercel --prod`.

## Smoke test

```bash
curl -sS -X POST "https://<your-project>.vercel.app/api/send" \
  -H "Content-Type: application/json" \
  -H "X-Relay-Secret: <RELAY_SECRET>" \
  -d '{"text":"hello from the relay"}'
```

A working deployment returns `{"ok":true}` and the chat receives `hello from the relay`. To reach the extra recipient, send the same request with `"to":"extra"`. That person must have pressed Start on the bot, and `TELEGRAM_EXTRA_CHAT_ID` must be their numeric chat id.

A missing or wrong secret returns HTTP 401 and `{"ok":false,"error":"unauthorized"}`. Nothing is sent.

## Local check

```bash
npm test
```

No install and no network. The tests use fake placeholders, not real credentials.
