# BLARC Trading Bot

BLARC is the Telegram bot @theBLARCbot plus a static product site. It is non-custodial. Users sign in their own wallet. The 1% fee is inside that signed transaction, or the swap is refused. It is inspired by the feature depth of Maestro Bots while using original BLARC branding, copy, layout, and assets.

## What Is Included

### Website (blarc.tech)

The static site at the repo root is intended for https://blarc.tech/. It describes only what the live bot does.

- Hero: tap-to-trade in Telegram, you sign every trade. Links to @theBLARCbot and x.com/blARCthedawg.
- Chain strip: Solana, Robinhood Chain, Arc, and the main EVM chains the bot swaps on.
- Bot overview with a mock of the tap menu (sell, buy, amount, Confirm, Back, Home).
- Features: quick swaps, copy trading (Copy or Skip), price alerts, watchlist, token scan cards, Goal/Risk/Auto, create or connect a wallet, Docker portability.
- A short note that BLARC is designed to extend into an AI-assisted community moderator for other projects.
- How it works: open the bot, connect or create a wallet, tap token and amount, confirm in your wallet.
- Security: non-custodial, WalletConnect, seed shown once then forgotten, public addresses only, anti-phishing.
- FAQ, official community links (t.me/BLARCHub, t.me/BLARCUpdates, x.com/blARCthedawg), and a privacy and disclaimer footer.
- Open Graph and Twitter card tags, favicons cut from the BLARC mark, `robots.txt`, and `sitemap.xml` for https://blarc.tech/.

### Telegram Bot MVP

- `/start` onboarding.
- `/help` command list.
- `/create` makes a new 12-word wallet in memory. The seed is shown once in that chat only after a confirmation tap, then forgotten. Only the public EVM and Solana addresses are saved. The bot cannot sign that wallet. Import the seed into your own wallet and use `/connect`.
- `/connect` starts a non-custodial WalletConnect pairing and sends a QR plus pairing URI. Approval saves only the public address and chain id.
- `/disconnect` forgets that public address.
- `/fee` shows the 1% (100 bps) fee and which public wallet applies to the connected chain.
- `/swap <amount> <from> <to>` asks the user's wallet to sign one swap. The 1% is inside that transaction, paid to the chain's fee wallet. If the fee cannot be included, nothing is signed. On Solana the 1% is a transfer to `X4WBhCgYQFoeugPcevRxgAq7ZWuyu13w646Wh4WY5wL` inside that same transaction. Copies use that same fee path. If the transfer cannot be added, nothing is signed. On Robinhood (chain 4663) the signed call is the BLARC fee router `0x9FC7993E0250D54fE04317A99369Bdd3f0262D58`, which pays fee recipient `0x729241d4d22cb8bD54E9210D1FE1e16b74A2a784` and swaps the rest through SwapRouter02 `0xCaf681a66D020601342297493863E78C959E5cb2`. It is not a direct 0x swap. `/swap` uses `BLARC_ROBINHOOD_ROUTER` and refuses if that contract has no code or the fee wallet is not that recipient.
- `/wallet <address>` add a read-only public wallet.
- `/copy <address>` watch a public Solana or EVM wallet. Seeds and private keys are rejected. A real trade gets Copy and Skip buttons. A Solana copy asks your wallet to sign the same 1% fee swap to `X4WBhCgYQFoeugPcevRxgAq7ZWuyu13w646Wh4WY5wL`. If that fee cannot be included, nothing is sent.
- `/copies`, `/uncopy`, `/auto on|off`, `/goal <percent>`, `/risk low|average|high|daredevil`.
- Auto does not sign. It asks the user to sign the same fee-aware swap. No connected wallet means no trade.
- A weekly goal is stored as a percent. Profit tracking is not live, and no balance is invented.
- Risk tiers label a trade only from sell size versus `/risk max <amount>`. Otherwise sizing is manual. No risk-reward ratio is invented.
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
- The bot never holds a key. A swap signature is requested only through WalletConnect, and only when the 1% fee is inside that transaction.
- Market lookups use DexScreener's public read-only API; responses are informational, not trading advice.
- Price alerts poll DexScreener about once a minute and send one Telegram message per target cross. They do not trade, sign, or hold keys.
- A pasted contract on `/price` or `/watch` saves one pair card under `data/cards/<chainId>-<tokenAddress>.jpg`. Later price alerts and existing buy notices reuse that file. Generated cards are gitignored so a persistent `data` volume keeps them.
- Wallet features store public addresses only. BLARC does not store private keys, seed phrases, or signing permissions.
- WalletConnect relay keys stay in process memory. They are not written to `data/blarc-state.json`. `/create` holds a new seed in memory only until the one-time reveal, then drops it. The state file keeps the public addresses only.
- The 1% fee is not custody. It is part of the swap transaction the user signs, or the swap is refused.
- Copy trading stores public watch addresses only. Mirrored swaps go through the fee-aware swap builder. If that builder refuses, nothing is signed. When `BLARC_EVM_RPC_URL` is empty, Robinhood copy watching uses the public RPC `https://rpc.mainnet.chain.robinhood.com` (chain 4663) and does not report a trade if that call fails. When `BLARC_SOLANA_RPC_URL` is empty, Solana copy watching uses the public RPC `https://api.mainnet-beta.solana.com`. A Solana mirror is that same user-signed swap with the 1% fee inside it. If the fee cannot be included, nothing is sent and there is no fee-less fallback.

For any future trading backend, add threat modeling before implementation. At minimum, define key custody boundaries, wallet encryption, confirmation flows, rate limiting, anti-phishing protections, logging redaction, abuse monitoring, and incident-response procedures.

## Local Preview

The site is static (`index.html`, `styles.css`, `script.js`, `assets/`, `favicon.ico`, `robots.txt`, `sitemap.xml`) and lives at the repo root, so GitHub Pages or Cloudflare Pages can serve the root directly with no build step. It does not need the bot process. The intended domain is https://blarc.tech/. Canonical, Open Graph, and sitemap URLs already point there.

Preview it locally:

```bash
python -m http.server 4173
```

Then visit `http://localhost:4173`. On a VPS, point nginx, Caddy, or another static server at the same directory. DNS for blarc.tech is set up separately with the host you choose.

## Run The Telegram Bot

Requires Node.js 20 or newer. The bot is plain Node ESM and starts with `node src/bot.js`.

1. Clone this repository and enter its directory.
2. Create a bot with BotFather and copy the token.
3. Copy `.env.example` to `.env` and fill it in. `.env` is gitignored. Set `TELEGRAM_BOT_TOKEN`. For pairing, set `WALLETCONNECT_PROJECT_ID` from Reown (WalletConnect) Cloud. `ZEROX_API_KEY` is required for non-Robinhood 0x swaps (Swap API from https://dashboard.0x.org). Without it those swaps refuse and nothing is signed. Robinhood chain 4663 does not use that key. Do not write a real key into git. Leave `BLARC_EVM_RPC_URL` empty to watch Robinhood copies on `https://rpc.mainnet.chain.robinhood.com` (chain 4663). Leave `BLARC_SOLANA_RPC_URL` empty to use `https://api.mainnet-beta.solana.com` for Solana copy watching and the in-swap fee read. Fee fields are public addresses that receive the 1% inside a swap (`BLARC_FEE_ADDRESS` for EVM and for Celo chain 42220, `BLARC_FEE_ADDRESS_SOL` for Solana, which must be `X4WBhCgYQFoeugPcevRxgAq7ZWuyu13w646Wh4WY5wL` or the swap is refused, `BLARC_FEE_ADDRESS_ROBINHOOD` for Robinhood chain 4663, which must be `0x729241d4d22cb8bD54E9210D1FE1e16b74A2a784`, `BLARC_FEE_ADDRESS_ARC` for Arc chain 5042). Robinhood swaps also need `BLARC_ROBINHOOD_ROUTER` set to the deployed fee router `0x9FC7993E0250D54fE04317A99369Bdd3f0262D58`. That router pays the recipient above and calls SwapRouter02 `0xCaf681a66D020601342297493863E78C959E5cb2`. Do not put private keys, seed phrases, or real tokens into git. Empty `BLARC_BOT_USERNAME`, `BLARC_SUPPORT_URL`, and `BLARC_UPDATES_URL` fall back to the built-in public defaults.
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

Runtime state is `data/blarc-state.json` (saved wallets, watches, and settings). Pair cards, when built, are `data/cards/<chainId>-<tokenAddress>.jpg`. That directory must persist across restarts and deploys. The Compose file mounts `./data` for this. Do not delete it if you want that state to survive. Back it up with the host.

Optional: register Telegram command suggestions from a machine that has the filled-in `.env`:

```bash
npm run bot:commands
```

The wallet packages are `@walletconnect/sign-client` and `qrcode`. EVM swaps are user-signed `eth_sendTransaction` requests. Solana swaps are user-signed `solana_signAndSendTransaction` requests with a 1% transfer in the same transaction. No swap is requested unless the 1% fee is inside it.

## Files

- `index.html` - page structure, copy, and meta tags for blarc.tech.
- `styles.css` - responsive dark glass visual system.
- `script.js` - FAQ toggles, card tilt, sticky header state.
- `assets/` - BLARC mascot, logo, poster, guide cards, favicons, and the `og-card.jpg` share image.
- `favicon.ico`, `robots.txt`, `sitemap.xml` - site metadata for https://blarc.tech/.
- `src/bot.js` - thin entry: wires config, state, commands, and the price-alert loop, then polls Telegram.
- `src/config.js` - environment reads and runtime constants.
- `src/state.js` - local JSON state load and save.
- `src/telegram.js` - Telegram send and getUpdates helpers.
- `src/commands.js` - command handlers.
- `src/alerts.js` - price-watch commands and the check loop.
- `src/createWallet.js` - in-memory 12-word wallet and public address derivation. No key is returned except the one-time mnemonic to the reveal step.
- `src/createCommand.js` - `/create` warning, confirmation button, one-time seed send, then public-address save.
- `src/wallet.js` - WalletConnect pairing, public-address session, and user-signed `eth_sendTransaction` requests.
- `src/swap.js` - 0x swap quote with the 1% fee inside the transaction, or a refusal. Chain 4663 calls the Robinhood fee router instead.
- `src/copy.js` - public-wallet copy watches. Solana mirrors call the same 1% fee swap. Execution only calls the fee-aware swap.
- `src/dexscreener.js` - read-only DexScreener market data adapter.
- `src/cards.js` - one JPEG card per chain and token contract, built with sharp from the DexScreener pair and the local BLARC mascot.
- `src/env.js` - loads `.env` from the working directory without overriding existing variables.
- `scripts/register-telegram-commands.js` - registers command hints with Telegram.
- `.env.example` - environment variable names. Copy to `.env` and fill in locally.
- `contracts/robinhood/` - Robinhood fee router, deployed at `0x9FC7993E0250D54fE04317A99369Bdd3f0262D58`. See `contracts/robinhood/README.md`.
- `Dockerfile` - Node 20 image that runs `node src/bot.js`.
- `docker-compose.yml` - runs the bot with `.env` and a persistent `./data` volume.
