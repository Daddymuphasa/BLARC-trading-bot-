# Security Policy

## Current Scope

The current project is a static website for BLARC. It does not provide live trading, wallet creation, custody, authentication, or Telegram bot command execution.

## Public Frontend Requirements

- Do not add third-party scripts without reviewing supply-chain risk.
- Do not request seed phrases, private keys, Telegram login codes, exchange API secrets, or wallet recovery material.
- Keep Content Security Policy restrictive by default.
- Keep all production assets local or loaded only from approved, integrity-reviewed origins.
- Avoid embedding hidden trackers or unreviewed analytics.

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
