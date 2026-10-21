# Chrome Web Store listing

**Name:** CrawlHive: memecoin safety scan in your terminal

**Summary (132 chars max):** comes from manifest.json: See the CrawlHive safety verdict on the memecoin page you are on: score, red flags, snipers, dev history and LP lock.

**Category:** Productivity (or Tools)

**Description:**

Stop switching tabs to check a memecoin. CrawlHive puts the swarm's safety verdict right on the token page of the trading terminal or explorer you already use.

Open a token page and a small panel shows up in the corner:

• Score and verdict: CLEAN, OK, RISKY or DANGER
• The worst red flags, each with a one-line reason
• Snipers: who bought in the first seconds and what they still hold
• Operators: holders, snipers and dev-funded wallets that share a funder, merged into one owner
• LP: burned, locked until a date, or unlocked
• The dev's earlier coins and how they ended, one tap away
• Compact by default: score, verdict and the worst red flags, the rest one tap away
• What changed since the last scan and a mini map of who holds the token
• One click to the full scan on crawlhive.xyz

Works for tokens on Solana, BNB Chain, Robinhood Chain and Base. The list of supported sites is on crawlhive.xyz/extension.

Free, no wallet, no account. The extension reads only the URL of token pages on supported sites and never touches your wallet.

Every CrawlHive verdict is checked against the price for 24 hours and hashed onchain, and the misses are public too: crawlhive.xyz/replay.

Not financial advice. Memecoins are extremely risky.

**Single purpose:** Show the CrawlHive safety verdict for the memecoin open in the current tab on supported trading sites.

**Permission justifications:**
- `storage`: remembers whether the panel is collapsed.
- Host permission `https://crawlhive.xyz/*`: fetches the verdict for the token in the page URL.
- Content scripts on the listed sites: read the page URL to find the token address and draw the panel.

**Data usage:** Does not collect personally identifiable information, health, financial, authentication, personal communications, location, web history or user activity. The page URL of supported token pages is sent to crawlhive.xyz only to return the verdict.

**Privacy policy URL:** https://crawlhive.xyz/extension/privacy

**Assets:** icon 128×128 (`icons/128.png`), screenshot 1280×800 (`public/extension/screenshot-1.png`), small promo tile 440×280 (`public/extension/promo-440x280.png`), marquee 1400×560 (`public/extension/marquee-1400x560.png`).


**Note (Oct 19, rejection Yellow Argon, keyword spam):** do not list third-party site names in the description, summary, popup or promo images. Keep the list of supported sites on crawlhive.xyz/extension only.

## What's new in 1.1.0 (paste into the store "What's new" / version notes if asked)

Cleaner panel: score ring, verdict and the three worst red flags up front, everything else behind "More". New in "More": what changed since the last scan, a mini bubble map of who holds the token, and wallets the swarm has already seen on other tokens. Works on more trading sites and block explorers, including BNB Chain and Base explorers.
