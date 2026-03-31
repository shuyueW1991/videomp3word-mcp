# videomp3word-mcp

Express MCP server for videomp3word.com. This package requires an upstream account credential and should be reviewed carefully before any public listing.

## What this server gives bots

- one MCP endpoint for video to mp3, video to word, mp3 to word, and word to mp3
- token-based billing that matches actual usage instead of subscription duration
- competitive package pricing
- a wrapper that keeps secrets in environment variables instead of source control

## Pricing

- 10 tokens: USD $0.99
- 100 tokens: USD $8.90
- 500 tokens: USD $34.90

The server also queries live task-token prices from videomp3word.com for each conversion mode.

## Safety model

- no code is imported from `/home/wangshuyue/videomp3word/video_to_text`
- no local secrets, cookies, or keys are committed
- the server sends upstream credentials only to the configured `VIDEOMP3WORD_BASE_URL`
- restricted conversion tools can require `Authorization: Bearer <key>`, but leaving `MCP_ACCESS_KEYS` unset makes paid tools publicly callable
- remote input URLs are validated to block localhost and private-network targets
- generated artifacts stay in memory and expire automatically

## Trust notes

- `VIDEOMP3WORD_SESSION_COOKIE` is a sensitive credential that can spend the upstream account's token balance
- use a dedicated upstream account for this deployment instead of a personal or production browser session
- set `MCP_ACCESS_KEYS` before exposing the server on a public hub
- confirm the registry listing mirrors the environment requirements declared in this repository

## Environment

**Crucial Security Warning**: This server acts as a proxy to an upstream `videomp3word.com` account. It spends tokens on behalf of the account whose session cookie is provided. You MUST configure the `VIDEOMP3WORD_SESSION_COOKIE` environment variable, and you SHOULD configure `MCP_ACCESS_KEYS` to prevent unauthorized agents from spending your tokens.

Set these variables before deployment:

- `VIDEOMP3WORD_SESSION_COOKIE` **(REQUIRED)**: session cookie for the upstream videomp3word account that owns the shared tokens. This is a sensitive credential.
- `VIDEOMP3WORD_ALLOWED_UPSTREAM_HOSTS`: optional comma-separated allowlist for `VIDEOMP3WORD_BASE_URL`, default `videomp3word.com,www.videomp3word.com`
- `MCP_ACCESS_KEYS` **(STRONGLY RECOMMENDED)**: comma-separated bearer keys that gate paid tools. If left unset, paid conversion tools are publicly callable and will drain your token balance.
- `VIDEOMP3WORD_BASE_URL`: upstream site URL, defaults to `https://videomp3word.com`
- `VIDEOMP3WORD_API_KEY`: optional upstream API key sent alongside the required session cookie when available
- `PUBLIC_BASE_URL`: public base URL of this MCP deployment, used for artifact download links
- `BOT_PURCHASE_URL`: where bots buy access or tokens
- `BOT_KEY_PORTAL_URL`: where bots retrieve their access key after purchase
- `BOT_SUPPORT_URL`: support or contact page for bot operators
- `ARTIFACT_TTL_SECONDS`: optional artifact lifetime, default `1800`
- `HOST`: optional bind host, default `0.0.0.0`
- `PORT`: optional port, default `3000`

`VIDEOMP3WORD_SESSION_COOKIE` is required for the current videomp3word.com routes, including shared token balance lookups.

## Install

```bash
npm install
npm run build
npm start
```

## MCP endpoint

- POST `/mcp`
- GET `/health`
- GET `/artifacts/:artifactId`

## Tools

- `videomp3word_catalog`: explains the one-endpoint workflow, token billing benefit, and onboarding links
- `videomp3word_pricing`: returns package prices plus live task-token prices
- `videomp3word_buy_access`: returns purchase, key-portal, and support URLs
- `videomp3word_token_balance`: reads the shared upstream token balance
- `videomp3word_convert`: runs any supported conversion mode through one tool

## Request examples

Video to word:

```json
{
  "mode": "video_to_word",
  "sourceUrl": "https://example.com/demo.mp4"
}
```

Word to mp3:

```json
{
  "mode": "word_to_mp3",
  "text": "Hello from videomp3word bots.",
  "format": "mp3",
  "voice": "Cherry",
  "languageType": "Chinese"
}
```

## Deployment notes

- configure `BOT_PURCHASE_URL` and `BOT_KEY_PORTAL_URL` before listing the server publicly
- keep `MCP_ACCESS_KEYS` outside the repository and enable them before public exposure
- verify the upstream videomp3word session owns enough tokens for public traffic
