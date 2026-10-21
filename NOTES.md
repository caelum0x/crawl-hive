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
