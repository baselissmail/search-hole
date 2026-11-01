# The search-hole dashboard

The dashboard is a small website that runs on your own computer. It answers three questions:

1. **What did Claude search for, and what came back?**
2. **What did search-hole hide, and why?**
3. **How do I change that?** You add rules, manage lists and change settings without typing commands.

Everything stays on your machine. The dashboard reads the same data and rules as the CLI and the plugin, so a change made here applies to every app from its next search.

## Opening it

- In Claude Code: `/search-hole:dashboard`
- In a terminal: `searchhole ui --open`

Either one starts the dashboard at `http://127.0.0.1:7341` and opens your browser already signed in.

**How sign-in works, and why:**

- There's no password. The command gives the browser a link that works **once** and only for **60 seconds**. Any website you visit could try to talk to a server on your computer, so the dashboard only trusts someone who just ran the command.
- The session lasts until you close the tab or the dashboard stops. Nothing goes into cookies.
- If you see the "Sign in" screen, run the command again.

**When it stops:** after 30 minutes with no activity, so it doesn't run forever in the background. `/search-hole:dashboard --stay` keeps it running.

## The layout

| Part | What it is |
|---|---|
| **Left menu** | The four pages: Live log, Rules & lists, Engines, Settings. The key next to each one (for example `G` `L`) jumps there. At the bottom: the command menu and the shortcut list. |
| **Overview header** | The last 7 days in a few numbers, at the top of every page. |
| **The page** | Whichever page you picked. |
| **Footer** | The search-hole version, and the address the dashboard runs on. |

## Overview header (top of every page)

A quick health check, so you can see at a glance whether search-hole is doing anything.

| Number | What it shows | Why it's there |
|---|---|---|
| **Searches · 7 days** | How many searches ran this week. | Shows that search-hole is seeing Claude's searches at all. |
| **Hidden** | How many results were hidden this week. | The main sign of whether it's useful to you. If this stays near 0, it isn't changing much. |
| **Built-in vs engines** | A bar: searches through Claude's own WebSearch compared with search-hole's engines. | Shows which path your searches take. In Claude Code it's normally all built-in. |
| **Mode** | The search mode. "Auto → Built-in" means you chose Auto, and it used built-in because no engine was available. | So you can see what actually happened, not only what you set. |
| **Engines used** | The engines that served searches, top 3. | Only matters when you use engines (SearXNG, Brave, Tavily). |
| **Sources kept** | What kinds of pages were kept: Official, Docs, Forum, Blog, News, Repo, Reference, Content farm, Unknown. | Shows the quality mix of what Claude reads. More Official and Docs is better. |
| **Top hidden** | The 3 sites hidden most often. | Tells you which rules or lists are doing the work, and catches a site hidden by mistake. |

On a phone, only the first numbers show.

## 1. Live log

**What it is:** every search, newest first, updated live while Claude works.

**Why it exists:** this is the heart of the dashboard. It's the only place you can see what Claude searched, what came back, and what search-hole removed. Checking hidden sites by hand starts here.

### The table

| Column | Meaning |
|---|---|
| **Time** | When the search ran. Hover for the full date. |
| **Query** | What Claude searched for. Queries are checked for secrets before they're stored. |
| **Mode** | **Built-in** (Claude's own WebSearch, filtered) or **Engines** (search-hole's engines). |
| **Engines** | Which engines answered. Empty for built-in. |
| **Kept** | Results Claude got to see. |
| **Hidden** | Results search-hole removed. Red when it's more than 0. |
| **Latency** | How long search-hole took. |
| **Client** | Which app searched, for example `claude-code`. |

### Above the table

- **Live indicator:**
  - **Live** means new searches arrive instantly.
  - **Reconnecting…** means the live connection dropped and is coming back.
  - **Updating every 2 s** means the live connection isn't available, so the page checks every 2 seconds instead.
- **Only searches that hid results:** a filter that shows just the searches where something was removed. It's the fastest way to review what was left out.

**While you're reading:** new searches don't push the rows around while you hover, scroll or select. A "new searches" button appears at the top instead; click it to show them.

**Older searches** load as you scroll down.

### Opening a search (its results)

Click a row, or press Enter, to see every result of that search.

| For each result | Why |
|---|---|
| **Rank, site, title and URL** | What the result was. Only `http` and `https` addresses become links. Web text is shown as plain text, never run as code. |
| **Decision:** Kept, Hidden or Pinned | What search-hole did with it. |
| **Reason:** Your rule, A list, Too old, No date found, or Not on the allowlist | Why it was hidden. |
| **The rule that fired** | Hover to see the exact rule and its level (session, project, global or list). This is how you find a wrong rule. |
| **Source type** | Official, Docs, Forum, and so on. |
| **Engine** | Built-in, or which engine found it. |
| **Quick actions:** Block, Allow, Pin, Raise, Lower | Change the rule for that site in one click. |

**What the quick actions do:**

- **Block:** hide this site from results.
- **Allow:** always show it, even if a list blocks it. Use this when a list hid a good site.
- **Pin:** put this site's results first.
- **Raise / Lower:** move it up or down.

Every action shows an **Undo** for 8 seconds. That's why there are no "Are you sure?" dialogs: mistakes are cheap to reverse.

**Not shown yet:** whether Claude actually *opened* each kept result. You can see what was hidden, but not which kept pages Claude read and which it ignored. (Your dogfooding finding; not built yet.)

## 2. Rules & lists → Rules

**What it is:** your own rules, in one place.

**Why it exists:** rules are how you tell search-hole what you trust and what you don't. Your rules always beat lists. When two of your rules clash, the more local one wins: session, then project, then global.

### Add rule

| Field | Meaning |
|---|---|
| **Match** | Which pages: a domain (`example.com`), a host and path, a URL pattern with `*`, or a `/regex/`. |
| **Action** | Block, Allow, Pin, Raise or Lower. |
| **Weight** | For Raise and Lower only: 1 is a nudge, 10 a shove. |
| **Scope** | **Global** (every project) or **Project** (only the current one). |
| **Until** (optional) | The rule stops after this day. Good for temporary rules. |
| **Note** (optional) | A reminder to yourself of why you added it. |

### Your rules

A table of every rule: Match, Action, Weight, Scope, Source (the file the rule is stored in, such as `rules.yaml`, or a project's `.searchhole.yaml`) and Note (including an end date, if it has one). You can sort it and filter it, and remove any rule with Undo.

### Test a URL

Paste a URL to see what your rules would do with it and every rule that matched. Nothing is downloaded; only the rules are checked.

**Why:** to answer "why was this hidden?" or "will my new rule catch this?" without waiting for a real search.

### Suggestions

Claude can *propose* a rule (the `suggest_rule` tool), for example "lower geeksforgeeks.org: often outdated". The proposal waits here with Claude's reason. **Nothing applies until you click Approve.** Reject throws it away. An approval can be undone like any other rule.

**Why:** Claude notices bad sources while it works, but must never change your rules by itself. This keeps you in charge.

## 3. Rules & lists → Lists

**What it is:** block lists that other people maintain, like an ad blocker's filter lists, plus search-hole's own lists.

**Why it exists:** writing rules for hundreds of junk sites by hand isn't realistic. Lists give you that protection out of the box, and this page shows whether they're helping.

### The summary at the top

- "Lists hid 42 results this week; audit lists would have hidden 17 more."
- **Most:** the lists that did the most.
- **Needs attention:** lists whose update failed.

### The table

| Column | Meaning |
|---|---|
| **List** | Its name and where it comes from: built-in, starter, subscribed or imported. Click the row for details. |
| **Mode** | **Enforce** hides what the list matches. **Audit** only records what it *would* hide, and hides nothing. **Off** doesn't apply it. A change happens at once, with Undo. |
| **Rules** | How many rules the list has. |
| **Updated** | When it was last downloaded, and when it will be next. |
| **This week** | How many results it hid, or would have hidden in Audit. |
| **Actions** | Update now, try again after an error, or remove. Only lists you added can be removed; built-in and starter lists can only be switched off. |

**Why Audit exists:** a new list might hide good sites. Audit lets you watch what it *would* do for a while, then switch to Enforce once you trust it. New subscriptions start in Audit for that reason.

**Errors:** a failed update shows the error *and* how to fix it. The old copy keeps working in the meantime.

### Buttons

- **Browse catalog:** lists you can add, each with what it does, its licence and size, and whether you already have it. "Add" subscribes in the recommended mode.
- **Update all:** download fresh copies now.
- **Subscribe by address:** add any list by its web address (`https://…`), with an optional name, its kind, its format (uBlacklist, AdGuard, hosts, plain domains, Goggles), a mode (Audit by default) and how often to update it. Lines search-hole can't read are counted and skipped.

**Updates:** lists refresh in the background after a search, each on its own schedule. You can turn that off in Settings.

## 4. Engines

**What it is:** the search engines search-hole can use (SearXNG, Brave, Tavily, …) and the health checks.

**Why it exists:** when searches go through engines, you need to know which ones work and why one doesn't. **In Claude Code you can mostly ignore this page,** because built-in mode needs no engine. It matters for Claude Desktop, Cursor, VS Code and the other apps.

### Engine cards

One card per engine:

| Fact | Meaning |
|---|---|
| **Health** | Healthy, Unhealthy or Unknown. |
| **Why inactive** | No API key, no endpoint set, turned off, spend cap reached, suspended, and so on. |
| **Key** | *Where* the key comes from (keychain, environment, …). The key itself is never shown. |
| **Last error** | For example "Rate limited" or "Key rejected". |
| **Suspended until** | When an engine fails in certain ways, for example its quota is used up, search-hole pauses it for a while instead of slowing every search. |
| **Endpoint / Attribution** | Where it sends queries, and the credit the engine requires. |

**Check now** tests every engine immediately.

### Checks

The same checks as `searchhole doctor`: Node version, hooks, engines, keys and files. Each one shows OK, Warning, Failed or Info, and a **Fix** line when something is wrong.

## 5. Settings

**What it is:** the main switches from `settings.yaml`, without editing the file.

**Why it exists:** so you can change behaviour safely, with explanations next to each option. Changes apply to every app from its next search. A setting pinned by an environment variable shows as locked.

| Section | What you control | Why it matters |
|---|---|---|
| **Search mode** | **Auto:** engines when one is healthy, otherwise Claude's own WebSearch, filtered. **Built-in:** always Claude's own WebSearch, with your blocks added and the results filtered again. **Engines:** always search-hole's engines; built-in only if every engine fails. | Picks the search path. Built-in needs no setup. |
| **Query hygiene** | **Secrets** in a query: Block (refuse and say why), Redact (replace with `[redacted]`), or Off. **Private addresses** (internal hosts, `192.168.x.x`): Block, Cut out (the default), or Off. | Stops private data from leaking to a search provider through a query. |
| **Loop limits** | Searches per turn (default 40), searches per hour (120), and the same search again (refused on the 3rd repeat within 10 minutes). 0 turns a limit off. | Stops an agent that searches in circles, which matters most when nobody is watching. |
| **History** | How long to keep searches (default 90 days), and the **receipt line** that Claude Code shows after a turn that searched. | Your log stays on your machine and doesn't grow forever. |
| **Appearance** | Light, dark or system theme. Stored in this browser only. | Comfort. |
| **Lists** | Update lists in the background, on or off. | Off means lists change only when you press Update. |
| **Files** | Where your config and data live (normally `~/.searchhole`). | So you know where to look, back up, or delete. |

## Keyboard and command menu

The whole dashboard works without a mouse.

| Keys | Does |
|---|---|
| `⌘K` | Command menu: go to a page, Add rule, Check engines, Update all lists, Browse list catalog, Show searches that hid results, change the theme. |
| `?` | Show all shortcuts. |
| `G` then `L` / `R` / `E` / `S` | Go to Live log / Rules / Engines / Settings. |
| `J` / `K` (or ↓ / ↑) | Next or previous search or result in the Live log. |
| `Enter` / `→` | Open a search's results. `←` or `Esc` goes back. |
| `B` `A` `P` `R` `L` | On a selected result: Block, Allow, Pin, Raise or Lower its site (with Undo). |

**Why:** reviewing many searches is much faster with `J`, `K` and one-key actions than with clicking.

## Safety, in short

The dashboard can change your rules, and any website open in your browser could try to reach a server on your computer. So:

- It only listens on `127.0.0.1`. It rejects requests addressed to any other host name, and changes sent from any other website.
- You sign in with a one-time, 60-second link. There's no password and no cookie.
- Text from the web (titles, URLs, list names) is always shown as plain text, never as HTML or code.
- A strict security policy blocks any script that isn't the dashboard's own.

## Not built yet

- **Opened vs not opened:** which kept results Claude actually read (see the Live log section).
- A page per session or receipt, a Sources page, and an Apps page.
- **Delete all data** from the dashboard. Today: `searchhole uninstall --purge`.
- The full overview on phones.
