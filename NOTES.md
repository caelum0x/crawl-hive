# Owner notes — crawl-hive

Repo reality check (2026-10-21): this is `h100envy/crawl-hive`, a third-party upstream repo
cloned locally for reference/contribution. Our GitHub account (`caelum0x`) has **READ-only**
access (`viewerPermission: READ`, confirmed via `gh repo view` and a 403 on `git push origin main`).
We do not control crawlhive.xyz's deploy (not on `box` / `railyard-box` — no matching Docker
container found on either host).

## Owner-only blockers

- Push access: `caelum0x` cannot push to `h100envy/crawl-hive` (403, read-only collaborator role
  or none at all). If this is meant to be a real upstream contribution, the owner needs to either
  get `caelum0x` added as a write collaborator on `h100envy/crawl-hive`, or confirm `h100envy` is
  an account the owner also controls and can merge from directly. Until then, every change here
  ships as a PR to the fork (`caelum0x/crawl-hive`) and the owner (or `h100envy`) has to click merge
  on GitHub — that click is the only remaining step: https://github.com/h100envy/crawl-hive/pull/5
- Live-site anomaly (owner should eyeball, not urgent): `https://crawlhive.xyz/` and
  `https://crawlhive.xyz/robots.txt` currently return two `<title>` tags in one response — a stale
  `404: This page could not be found.` title followed by the real page title, plus a stray
  `<meta name="robots" content="noindex">`. Does not reproduce on a clean local `next build && next start`
  of this exact commit, so it looks like an edge-cache/ISR artifact on their deployment
  (`x-nextjs-cache: HIT` was present), not a source bug — can't fix blind without deploy access.
  Likely hurting SEO (duplicate title, accidental noindex signal) on exactly the pages this session
  tried to make more crawlable.

## What shipped this session (all via PR #5, pending merge)

- Pushed 3 previously stuck local-only commits (LP-unlock fix, robots.txt/sitemap.xml) to
  `caelum0x/crawl-hive` and opened PR #5 against `h100envy/crawl-hive` after merging in the newer
  `origin/main` (Brain API) with a manual, non-destructive merge commit (one README conflict,
  resolved by keeping both changelog entries).
- New: `/brain` and `/dev/<wallet>` pages added to `sitemap.xml` (previously only `/scan/<address>`
  was listed, despite the file's own comment saying dev pages should be there too). Selection logic
  factored into a pure, unit-tested `wallet-mem-select.ts` (5 new tests).

### 2026-10-22 session

- PR #5 still **OPEN**, still blocked on the same owner-only click (`caelum0x` is still READ-only
  on `h100envy/crawl-hive`, confirmed again via `gh repo view`). Merged the 8 new upstream commits
  (operator watch, deployer/pool-creator split, unbounded SQLite Brain memory, pricing tiers, paper
  trading) into local `main` with a manual non-destructive merge (2 conflicts: README changelog
  ordering, an import-list conflict in `scan-operators.ts` — kept both sides' imports) so PR #5
  doesn't rot further behind upstream. `tsc --noEmit`, `next build`, and the existing `node --test`
  suite (8/8) all pass after the merge.
- Shipped: `/pricing` (the Free/Holder/Pro/Whale page, linked from the nav on every page since the
  upstream pricing-tiers commit) was missing from `sitemap.ts` — zero search signal on the page that
  sells the paid tiers. Added it (priority 0.8/weekly). Also added `/watchlist` to `robots.ts`'s
  disallow list, since like `/my` it only ever shows the connected wallet's own private data, not
  indexable content. Verified live: built + `next start`, curled `/robots.txt` (shows `Disallow:
  /watchlist`) and `/sitemap.xml` (contains `<loc>https://crawlhive.xyz/pricing</loc>`, no
  `/watchlist` entry).
- **"Real-money paths" caution, investigated**: this app moves real funds on-chain in several
  places — `src/lib/server/buyback.ts` + `buyback-tx.ts` (treasury wallet buys and burns
  $CRAWLHIVE every 12h, Phantom-signed, build/confirm split so the server only ever builds an
  unsigned tx and the human signs), `src/lib/server/launch.ts` + `launch-evm.ts` (Clean Launch:
  mint/create key made client-side, server only forwards a byte-for-byte match of what it built,
  never holds a launch key), `src/lib/server/rewards.ts` (reward payouts, same
  build-then-confirm-signed-tx split), `src/lib/server/dexfund.ts` (DEX fund gifts, now closed per
  `DEX_FUND_OFF`), `src/lib/server/x402.ts` (x402 USDC micropayments per API call, revenue counted
  into the buyback pool), and the new Pro-tier burn-to-pay flow (`src/app/api/user-burn/route.ts`,
  `src/app/api/tier/route.ts`). Every path I found follows the same shape: the server never holds a
  user-funds-moving private key, it only builds unsigned transactions that the user's or treasury's
  own wallet (Phantom/MetaMask) signs client-side, and `*-confirm` routes just record an
  already-broadcast, already-signed tx by its signature. Did not touch any of these files this
  session — the gap I shipped (`sitemap.ts`/`robots.ts`) is pure SEO metadata, no money code
  touched.
