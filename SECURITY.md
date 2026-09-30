# Security Policy

## Current Scope

The current project includes a static website and a Telegram bot for BLARC. It does not take custody of keys or sign transactions. `/create` can show a new seed once in the chat after confirmation, then discards it. A swap is sent to the user's wallet only when the 1% fee is inside that same transaction. Otherwise nothing is requested. On Robinhood chain 4663 that transaction is a call to the BLARC fee router. If `BLARC_ROBINHOOD_ROUTER` is unset or has no code, nothing is sent and there is no direct-swap fallback. The router is deployed at 0x9FC7993E0250D54fE04317A99369Bdd3f0262D58.

## Public Frontend Requirements

- Do not add third-party scripts without reviewing supply-chain risk.
- Do not request seed phrases, private keys, Telegram login codes, exchange API secrets, or wallet recovery material.
- Keep Content Security Policy restrictive by default.
- Keep all production assets local or loaded only from approved, integrity-reviewed origins.
- Avoid embedding hidden trackers or unreviewed analytics.

## Telegram Bot MVP Requirements

- Never ask for seed phrases, private keys, Telegram login codes, exchange keys, or recovery material.
- Keep bot tokens in environment variables only.
- Do not commit `.env` files or runtime JSON state.
- Treat all user-submitted contract and wallet addresses as untrusted text.
- Keep HTML escaping enabled for bot replies.
- Restrict admin-only commands with numeric Telegram user IDs.
- Rate-limit future high-volume features before enabling production alerts.
- Store public wallet addresses only. WalletConnect state on disk is limited to the approved public address and chain id for that chat.
- Keep WalletConnect relay key material in process memory. Do not write it to `data/` or logs.
- Do not add bot-side signing or private-key import. `/create` may generate a wallet in memory, show the seed once after a confirmation tap, and store only the public addresses. EVM swaps are `eth_sendTransaction` requests on the user's WalletConnect session, and only after the 1% fee is checked inside the quoted transaction. Solana swaps are `solana_signAndSendTransaction` requests, and only after a 1% transfer to the Solana fee wallet is inside that same transaction. The bot does not sign and does not submit a fee-less Solana swap.
- Copy watches store public addresses only. Reject seed phrases and private keys. Auto-copy may request the same user signature and must not sign. If the fee-aware builder refuses, do not send another transaction.
- Do not invent account balances, profit percentages, or risk-reward ratios. A weekly goal is a stored percent. A risk label requires a real size signal such as sell amount versus a user-set max.

## Future Bot And Trading Backend Requirements

Before implementing live trading features, document and review:

- Custody model and private-key handling.
- Encryption strategy for secrets at rest and in transit.
- Explicit user confirmation for transfers, approvals, snipes, copy trades, bridge actions, and withdrawals.
- Rate limits, abuse controls, and anti-spam protections.
- Anti-phishing link policy and official-channel verification.
- Audit logging with private data redaction.
- MEV, honeypot, tax, blacklist, owner, mint, and liquidity risk checks.
- Incident response, key rotation, and emergency-disable procedures.

## Reporting

Until a dedicated security email exists, open a private maintainer issue or contact the repository owner directly. Do not disclose active vulnerabilities publicly before maintainers have had time to respond.
