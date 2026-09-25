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
- `/scan <contract>` token format checks plus DexScreener liquidity, volume, and pair-age signals.
- `/watch <wallet>` wallet watchlist.
- `/watchlist` saved wallets.
- `/unwatch <wallet>` remove wallet.
- `/price <token>` live DexScreener pair lookup.
- `/alerts on|off` alert preference.
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

For any future trading backend, add threat modeling before implementation. At minimum, define key custody boundaries, wallet encryption, confirmation flows, rate limiting, anti-phishing protections, logging redaction, abuse monitoring, and incident-response procedures.

## Local Preview

Open `index.html` directly in a browser, or run a tiny local server:

```bash
python -m http.server 4173
```

Then visit `http://localhost:4173`.

## Run The Telegram Bot

1. Create a bot with BotFather. The current official handle is `@theBLARCbot`.
2. Copy `.env.example` to `.env` and set `TELEGRAM_BOT_TOKEN`.
3. In your shell, export the variables from `.env`.
4. Run:

```bash
npm start
```

Register Telegram command suggestions:

```bash
npm run bot:commands
```

No npm install step is needed right now because the bot uses Node.js built-in APIs.

## Files

- `index.html` - page structure and content.
- `styles.css` - responsive visual system.
- `script.js` - tab switching, FAQ toggles, sticky header state.
- `assets/` - BLARC mascot and logo images supplied for the brand.
- `src/bot.js` - Telegram bot MVP.
- `src/dexscreener.js` - read-only DexScreener market data adapter.
- `scripts/register-telegram-commands.js` - registers command hints with Telegram.
- `.env.example` - required bot environment variables.
