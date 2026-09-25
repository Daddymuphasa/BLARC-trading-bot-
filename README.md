# BLARC Trading Bot Landing Page

BLARC is a static, responsive product site for an Arc-native Telegram DeFi trading bot concept. It is inspired by the feature depth of Maestro Bots while using original BLARC branding, copy, layout, and assets.

## What Is Included

- Hero section with BLARC mascot branding and Telegram launch CTA.
- Supported-chain marquee.
- Flagship bot overview.
- Twelve core product features: cashback, auto snipe, copy trade, limit orders, multi-wallet, signals, trade monitor, funds management, bridge, Telegram scraper, referrals, and support.
- Product tabs for Scraper, Wallet Bot, Whale Bot, and Buy Bot.
- Security architecture section.
- Premium offer section.
- Documentation FAQ and community links.

## Security Notes

This repository is currently a static frontend. It does not collect private keys, seed phrases, Telegram login codes, analytics identifiers, or wallet credentials.

Security-minded implementation choices:

- No third-party frontend dependencies.
- No remote scripts, fonts, iframes, trackers, or analytics.
- A restrictive Content Security Policy in `index.html`.
- External links use `rel="noopener"`.
- Static assets are local under `assets/`.

For any future trading backend, add threat modeling before implementation. At minimum, define key custody boundaries, wallet encryption, confirmation flows, rate limiting, anti-phishing protections, logging redaction, abuse monitoring, and incident-response procedures.

## Local Preview

Open `index.html` directly in a browser, or run a tiny local server:

```bash
python -m http.server 4173
```

Then visit `http://localhost:4173`.

## Files

- `index.html` - page structure and content.
- `styles.css` - responsive visual system.
- `script.js` - tab switching, FAQ toggles, sticky header state.
- `assets/` - BLARC mascot and logo images supplied for the brand.
