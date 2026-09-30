# BLARC Trading Bot

BLARC is an Arc-native Telegram DeFi trading bot project with a responsive product site and a safe Telegram bot MVP. It is inspired by the feature depth of Maestro Bots while using original BLARC branding, copy, layout, and assets.

## What Is Included

### Website

- Hero section with BLARC mascot branding and Telegram launch CTA.
- Supported-chain marquee.
- Flagship bot overview.
- Twelve core product features: cashback, auto snipe, copy trade, limit orders, multi-wallet, signals, trade monitor, funds management, bridge, Telegram scraper, referrals, and support.
- Product tabs for Scraper, Wallet Bot, Whale Bot, and Buy Bot.
- Security architecture section.
- Premium offer section.
- Documentation FAQ and community links.

### Telegram Bot MVP

- `/start` onboarding.
- `/help` command list.
- `/connect` starts a non-custodial WalletConnect pairing and sends a QR plus pairing URI. Approval saves only the public address and chain id.
- `/disconnect` forgets that public address.
- `/fee` shows whether the public fee wallet is set and that the swap cut is 1% (100 bps).
- `/swap <amount> <from> <to>` previews a swap. The 1% is paid to `BLARC_FEE_ADDRESS` inside the swap. Nothing is broadcast.
- `/wallet <address>` add a read-only public wallet.
- `/wallets` saved read-only wallets with explorer links.
- `/remove_wallet <address>` remove a saved wallet.
- `/scan <contract>` token format checks plus DexScreener liquidity, volume, and pair-age signals.
- `/watch <token> [above <usd>] [below <usd>]` save a DexScreener price watch. `/watch <token> rearm` arms a fired target again.
- `/watchlist` shows each token, last USD price, and above/below targets.
- `/unwatch <token>` removes a price watch. Wallets stay on `/wallet`.
- `/price <token>` live DexScreener pair lookup.
- `/alerts on|off` gates delivery of price alerts for this chat. Default is on.
- `/settings` user settings.
- `/support` official links and anti-phishing reminder.
- `/broadcast <message>` admin-only announcements.

## Security Notes

This repository currently includes a static frontend and a safe-mode Telegram bot. It does not collect private keys, seed phrases, Telegram login codes, analytics identifiers, exchange credentials, or wallet credentials.

Security-minded implementation choices:

- No third-party frontend dependencies.
- No remote scripts, fonts, iframes, trackers, or analytics.
- A restrictive Content Security Policy in `index.html`.
- External links use `rel="noopener"`.
- Static assets are local under `assets/`.
- Bot runtime state is stored locally under `data/` and JSON state files are gitignored.
- Trading execution and wallet custody are intentionally not enabled.
- Market lookups use DexScreener's public read-only API; responses are informational, not trading advice.
- Price alerts poll DexScreener about once a minute and send one Telegram message per target cross. They do not trade, sign, or hold keys.
- Wallet features store public addresses only. BLARC does not store private keys, seed phrases, or signing permissions.
- WalletConnect relay keys stay in process memory. They are not written to `data/blarc-state.json`. A new wallet is created only in the user's own wallet app.
- The 1% fee is not custody. It is described on the swap preview as a payment to the public fee wallet inside the swap.

For any future trading backend, add threat modeling before implementation. At minimum, define key custody boundaries, wallet encryption, confirmation flows, rate limiting, anti-phishing protections, logging redaction, abuse monitoring, and incident-response procedures.

## Local Preview

The site is static (`index.html`, `styles.css`, `script.js`, and `assets/`). It does not need the bot process. Open `index.html` in a browser, or serve this directory with any static file server. For a quick local check:

```bash
python -m http.server 4173
```

Then visit `http://localhost:4173`. On a VPS, point nginx, Caddy, or another static server at the same directory.

## Run The Telegram Bot

Requires Node.js 20 or newer. The bot is plain Node ESM and starts with `node src/bot.js`.

1. Clone this repository and enter its directory.
2. Create a bot with BotFather and copy the token.
3. Copy `.env.example` to `.env` and fill it in. `.env` is gitignored. Set `TELEGRAM_BOT_TOKEN`. For pairing, set `WALLETCONNECT_PROJECT_ID` from Reown (WalletConnect) Cloud. Fee fields are public addresses that receive the 1% inside a swap (`BLARC_FEE_ADDRESS`, `BLARC_FEE_ADDRESS_SOL`, `BLARC_FEE_ADDRESS_ROBINHOOD`, `BLARC_FEE_ADDRESS_ARC`). Do not put private keys, seed phrases, or real tokens into git. Empty `BLARC_BOT_USERNAME`, `BLARC_SUPPORT_URL`, and `BLARC_UPDATES_URL` fall back to the built-in public defaults.
4. Install and start:

```bash
npm install
npm start
```

`npm start` loads `.env` from the current working directory. You do not need to export the variables yourself.

Or run the same process in Docker. The image is Node 20, reads env from `.env` (nothing is baked into the image), mounts `./data` so state can be written, and restarts unless you stop it:

```bash
docker compose up -d --build
```

Later starts can use `docker compose up -d`.

Runtime state is `data/blarc-state.json` (saved wallets, watches, and settings). That directory must persist across restarts and deploys. The Compose file mounts `./data` for this. Do not delete it if you want that state to survive. Back it up with the host.

Optional: register Telegram command suggestions from a machine that has the filled-in `.env`:

```bash
npm run bot:commands
```

The wallet packages are `@walletconnect/sign-client` and `qrcode`. Live swaps are still not sent.

## Files

- `index.html` - page structure and content.
- `styles.css` - responsive visual system.
- `script.js` - tab switching, FAQ toggles, sticky header state.
- `assets/` - BLARC mascot and logo images supplied for the brand.
- `src/bot.js` - thin entry: wires config, state, commands, and the price-alert loop, then polls Telegram.
- `src/config.js` - environment reads and runtime constants.
- `src/state.js` - local JSON state load and save.
- `src/telegram.js` - Telegram send and getUpdates helpers.
- `src/commands.js` - command handlers.
- `src/alerts.js` - price-watch commands and the check loop.
- `src/wallet.js` - WalletConnect pairing, public-address session, and the 1% swap preview.
- `src/dexscreener.js` - read-only DexScreener market data adapter.
- `src/env.js` - loads `.env` from the working directory without overriding existing variables.
- `scripts/register-telegram-commands.js` - registers command hints with Telegram.
- `.env.example` - environment variable names. Copy to `.env` and fill in locally.
- `Dockerfile` - Node 20 image that runs `node src/bot.js`.
- `docker-compose.yml` - runs the bot with `.env` and a persistent `./data` volume.
