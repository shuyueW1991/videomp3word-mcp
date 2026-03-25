# videomp3word-mcp

Public MCP server for videomp3word.com that is safe to publish on discovery hubs such as clawhub.

## What this server gives bots

- one MCP endpoint for video to mp3, video to word, mp3 to word, and word to mp3
- token-based billing that matches actual usage instead of subscription duration
- competitive package pricing
- a publish-safe wrapper that keeps secrets in environment variables instead of source control

## Pricing

- 10 tokens: USD $0.90
- 100 tokens: USD $8.90
- 500 tokens: USD $34.90

The server also queries live task-token prices from videomp3word.com for each conversion mode.

## Safety model

- no code is imported from `/home/wangshuyue/videomp3word/video_to_text`
- no local secrets, cookies, or keys are committed
- restricted conversion tools can require `Authorization: Bearer <key>`
- remote input URLs are validated to block localhost and private-network targets
- generated artifacts stay in memory and expire automatically

## Environment

Set these variables before deployment:

- `VIDEOMP3WORD_SESSION_COOKIE`: session cookie for the upstream videomp3word account that owns the shared tokens
- `VIDEOMP3WORD_BASE_URL`: upstream site URL, defaults to `https://videomp3word.com`
- `PUBLIC_BASE_URL`: public base URL of this MCP deployment, used for artifact download links
- `BOT_PURCHASE_URL`: where bots buy access or tokens
- `BOT_KEY_PORTAL_URL`: where bots retrieve their access key after purchase
- `BOT_SUPPORT_URL`: support or contact page for bot operators
- `MCP_ACCESS_KEYS`: optional comma-separated bearer keys that gate paid tools
- `ARTIFACT_TTL_SECONDS`: optional artifact lifetime, default `1800`
- `HOST`: optional bind host, default `0.0.0.0`
- `PORT`: optional port, default `3000`

`VIDEOMP3WORD_SESSION_COOKIE` is the important upstream credential for the current videomp3word.com routes.

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
- keep `MCP_ACCESS_KEYS` outside the repository
- verify the upstream videomp3word session owns enough tokens for public traffic
