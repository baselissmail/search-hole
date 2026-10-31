// SPDX-License-Identifier: CC0-1.0
/**
 * First-party `ai-content-farms` list (ADR-0016: first-party lists are CC0-1.0). Sites that
 * mass-publish machine-generated articles. Kind `content-farm`; bundled in **audit** mode
 * (ADR-0017 point 7): it records "would hide" until the user enforces it.
 *
 * Kept short and conservative. An entry needs both:
 * 1. a documented report with example pages: a closed block request in
 *    popcar2/BadWebsiteBlocklist (CC0-1.0), whose list carries the domain in its
 *    "Low Effort Articles (AI spam …)" section; and
 * 2. a concrete artefact in that report (the same article on several domains, invented
 *    authors or experts, false facts, generated filler) or an independent listing in another
 *    community list: laylavish/uBlockOrigin-HUGE-AI-Blocklist (CC0-1.0),
 *    insomnimus/seo-garbage (Apache-2.0), or alvi-se/ai-ublock-blacklist (GPL-3.0; cited as
 *    corroboration only, nothing is copied from it).
 * Reports that only say "AI spam" with no artefact and no second listing are left out, as are
 * long-running publications whose case is contested. Checked on 2026-10-31.
 *
 * Contributions: a public report with example pages and what shows they are generated, under
 * CC0-1.0. A site that merely uses AI somewhere does not belong here.
 */
import type { EvidencedEntry } from './evidence.ts'

export const AI_CONTENT_FARMS_ID = 'ai-content-farms'

const POPCAR2 = 'https://github.com/popcar2/BadWebsiteBlocklist/issues/'

export const AI_CONTENT_FARMS: readonly EvidencedEntry[] = [
  // One operator, seven domains, the same generated tech-support articles (issue #1 links the
  // identical "partition a hard drive in Windows 11" article on each).
  { match: 'solveyourtech.com', evidence: `${POPCAR2}1`, note: 'also listed in alvi-se' },
  { match: 'supportyourtech.com', evidence: `${POPCAR2}1`, note: 'also listed in alvi-se, seo-garbage' },
  { match: 'live2tech.com', evidence: `${POPCAR2}1`, note: 'also listed in alvi-se' },
  { match: 'masteryourtech.com', evidence: `${POPCAR2}1`, note: 'also listed in alvi-se' },
  { match: 'i5apps.com', evidence: `${POPCAR2}1`, note: 'also listed in alvi-se' },
  { match: 'mefmobile.org', evidence: `${POPCAR2}1`, note: 'also listed in alvi-se' },
  {
    match: 'umatechnology.org',
    evidence: `${POPCAR2}230`,
    note: 'also issue #1; listed in laylavish, alvi-se',
  },
  // Single sites with a documented artefact or a second listing
  {
    match: 'madpenguin.org',
    evidence: `${POPCAR2}78`,
    note: 'false facts and broken links shown; also listed in laylavish, alvi-se',
  },
  {
    match: 'gameslearningsociety.org',
    evidence: `${POPCAR2}235`,
    note: 'also listed in alvi-se, seo-garbage',
  },
  {
    match: 'webdevtutor.net',
    evidence: `${POPCAR2}181`,
    note: 'endless near-identical generated articles listed; also in seo-garbage',
  },
  {
    match: 'trycatchdebug.net',
    evidence: `${POPCAR2}150`,
    note: 'its contact page is a generated article; also listed in laylavish',
  },
  {
    match: 'toxigon.com',
    evidence: `${POPCAR2}211`,
    note: 'generated articles and malware redirects; also listed in seo-garbage',
  },
  {
    match: 'thelinuxcode.com',
    evidence: `${POPCAR2}186`,
    note: 'shared generated template, screenshot; also listed in alvi-se',
  },
  {
    match: 'techlivo.com',
    evidence: `${POPCAR2}34`,
    note: 'off-topic generated articles; also listed in alvi-se',
  },
  { match: 'techbloat.com', evidence: `${POPCAR2}227`, note: 'also listed in alvi-se' },
  {
    match: 'songtell.com',
    evidence: `${POPCAR2}160`,
    note: 'generated lyric interpretations; also listed in laylavish',
  },
  {
    match: 'robots.net',
    evidence: `${POPCAR2}6`,
    note: '"board of experts" with generated portraits; also issue #93; listed in alvi-se',
  },
  {
    match: 'linuxvox.com',
    evidence: `${POPCAR2}252`,
    note: 'generated author persona; also issue #281; listed in alvi-se',
  },
  {
    match: 'hatchjs.com',
    evidence: `${POPCAR2}220`,
    note: 'articles trail off or repeat, screenshot; also listed in alvi-se',
  },
  {
    match: 'clrn.org',
    evidence: `${POPCAR2}175`,
    note: 'invented history, false facts; also listed in alvi-se',
  },
  {
    match: 'dinosaur.org',
    evidence: `${POPCAR2}152`,
    note: 'invented dinosaur facts and generated images; also listed in laylavish',
  },
]
