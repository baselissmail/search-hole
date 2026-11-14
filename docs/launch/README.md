# Launch drafts

Drafts for Basel to edit and post himself (MASTER_PLAN §11 P8). Nothing here is posted by any tool.

| File | Where |
|---|---|
| [show-hn.md](show-hn.md) | Hacker News, "Show HN" |
| [reddit-selfhosted.md](reddit-selfhosted.md) | r/selfhosted |
| [reddit-claudeai.md](reddit-claudeai.md) | r/ClaudeAI |
| [reddit-localllama.md](reddit-localllama.md) | r/LocalLLaMA |
| [writeup-outline.md](writeup-outline.md) | Medium and LinkedIn write-up |
| [directories.md](directories.md) | Plugin and extension directories, awesome lists |
| [prelaunch-review.md](prelaunch-review.md) | Not a post: the 2026-11-14 review, as a checklist to clear first |

## Before posting anything

- [ ] The release is out, and installs from the public marketplace, npm and the `.mcpb` on macOS, Windows and Linux (docs/release.md step 7). Until then the `npx search-hole …` and `/plugin marketplace add …` commands in the drafts do not work; each carries a `[check: only true after the first release]` note.
- [ ] Every claim below is still true for that release, especially the bracketed `[check: …]` notes and the "limits" paragraphs. Delete a claim rather than soften it.
- [ ] The README quickstart works for a newcomer exactly as written.
- [ ] Record a hero GIF (a search, then the receipt line, then `/search-hole:block`) and add it to the README. The README has no image today, so no draft may point to one until this is done.
- [ ] The numbers you quote (tests, bundle sizes) come from that release, not from these drafts. The numbers from your own log are listed below; quote them with their dates.
- [ ] Say which apps you have tried for real. Today that is Claude Code on macOS only.
- [ ] Post one place at a time, and stay around for a few hours to answer questions. Same-day cross-posting reads as spam.
- [ ] Say that Claude Code helped build it. The commit history shows it, and people will ask.

## What two weeks of real use showed

Every draft opens with these facts. They come from the author's own log, 2026-10-31 to 2026-11-13: Claude Code on macOS, the default setup with no engine.

- 96 searches returned 1,243 results from 538 sites.
- The assistant opened pages from 37 of those 538 sites.
- Several sites came back in 5 to 10 separate searches and were never opened once.
- No rule and no list hid anything. The block lists that ship with search-hole never matched a result. (All the shipped lists together hold about 2,900 rules.)
- Over those 96 built-in searches, the gateway's own processing time was 2 ms at the median and 15 ms at the 95th percentile (31 ms at most).
- A publish date was found for 8 of the 40 pages opened through search-hole's `fetch`.

What they support: you can't see what your assistant searches or skips, and search-hole shows it and lets you act on it. Be plain that the block lists did nothing in this sample, and that the value so far is seeing, then deciding. Never name a site from the log, and never say what the searches were about.

## Tone

Plain and specific. What it does, how to try it, what it stores and where, and what it can't do. No "revolutionary", no "game-changer", and no comparisons with products you haven't measured. "Like Pi-hole, for AI search" is fine as a description of the idea, but never use Pi-hole's name or logo as branding (trademark, MASTER_PLAN §12.5).
