---
name: research
description: "Web research with search-hole: when to use search vs fetch, how deep to go, how to cite sources with dates, how to report what you opened, how to read warnings, and how to propose source rules with suggest_rule. Use whenever you search or open pages."
---

# Researching with search-hole

search-hole sits between you and the web. It applies the user's source rules (hidden sites, pinned sites, freshness limits) and logs every search so the user can audit it. Work with it, not around it.

## The tools

In Claude Code the tools are named `mcp__plugin_search-hole_search-hole__search`, `__fetch`, `__receipt` and `__suggest_rule`. Depending on the user's mode, the built-in WebSearch is either denied with a pointer to `search`, or allowed with its results filtered. Use whichever one you are given. Do not work around it: no curl or scraping through Bash, and no reaching a hidden site by another route.

## search or fetch

- **search** finds candidate sources. Make the query specific: product and version, the exact error text, a `site:` operator for a known domain. One focused query beats several vague ones.
- **fetch** reads one page. Use it when the user gives you a URL, or when a result looks authoritative and you need its real content. Titles and snippets are not evidence. A long page arrives in parts: continue with the returned `cursor` only while you still need more.
- Prefer official documentation and primary sources over summaries, mirrors and aggregators. Do not fetch every result; open the few that matter.

## How deep

- `quick`: one fact, a version number, a syntax check.
- `standard` (default): most questions.
- `deep`: contested or comparative questions, security, money, fast-moving topics, or anything where a wrong answer would hurt. It is slower and uses more of the user's engine quota, so say when you chose it and why.

## Cite with dates

- Give each source with its date when the result shows one, for example "react.dev, updated 2025-03". If no date is shown, say the date is unknown. Never guess one.
- For anything time-sensitive (versions, prices, APIs, news), prefer sources marked fresh. Flag a stale or undated source instead of presenting it as current.

## Say "opened", not "cited"

search-hole's receipt records which pages you opened (with fetch or WebFetch). It does not know which ones you relied on. So only say you read or checked a page if you opened it. A result you only saw in a list was seen, not read. Do not say a source confirms something unless you opened it.

## Read the warnings

Tool results can carry notes: results hidden by the user's rules, stale or undated sources, an engine that failed, a withheld summary, a refused fetch. Pass on the ones that affect the answer, in a sentence. If a fetch was refused by a rule, tell the user which rule (the message names it) and do not try another route to the same page.

## Rules: suggest, never change

You can never change the user's rules. If a site keeps getting in the way (a content farm, a copy of the docs, an outdated mirror), or an official source should come first, call `suggest_rule` once with a short reason and an evidence URL. Then tell the user the approval instruction it returns, word for word.

Never run `searchhole` or any search-hole command, never edit `rules.yaml` or `.searchhole.yaml`, and never look for a way to apply a rule yourself. A guard blocks those attempts in Claude Code, and the decision stays with the user.
