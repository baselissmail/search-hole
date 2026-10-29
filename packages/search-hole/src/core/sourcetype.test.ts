// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import type { ListKind, SourceType } from '../shared/types.ts'
import {
  classifyByPattern,
  classifySource,
  explainSource,
  SOURCE_PATTERNS,
  type SourceTypeDeps,
} from './sourcetype.ts'

const noLists: SourceTypeDeps = { typedLists: () => [] }

describe('classifySource: patterns', () => {
  it.each<[string, SourceType]>([
    ['https://www.nasa.gov/missions', 'official'],
    ['https://www.gov.uk/guidance/x', 'official'],
    ['https://www.service.gov.au/x', 'official'],
    ['https://www.who.int/news', 'official'],
    ['https://commission.europa.eu/x', 'official'],
    ['https://abcnews.go.com/x', 'unknown'],
    ['https://github.com/facebook/react', 'repo'],
    ['https://github.com/facebook/react/', 'repo'],
    ['https://github.com/facebook/react/releases/tag/v19.0.0', 'repo'],
    ['https://github.com/facebook/react/blob/main/README.md', 'repo'],
    ['https://github.com/facebook/react/tree/main/packages', 'repo'],
    ['https://github.com/facebook/react/issues/123', 'forum'],
    ['https://github.com/facebook/react/discussions/9', 'forum'],
    ['https://github.com/facebook/react/pulls', 'unknown'],
    ['https://github.com/topics/react', 'unknown'],
    ['https://github.com/facebook', 'unknown'],
    ['https://gitlab.com/group/sub/proj/-/releases', 'repo'],
    ['https://stackoverflow.com/questions/1/x', 'forum'],
    ['https://unix.stackexchange.com/questions/1/x', 'forum'],
    ['https://old.reddit.com/r/reactjs/comments/x', 'forum'],
    ['https://news.ycombinator.com/item?id=1', 'forum'],
    ['https://discuss.python.org/t/x/1', 'forum'],
    ['https://community.fly.io/t/x', 'forum'],
    ['https://docs.python.org/3/library/asyncio.html', 'docs'],
    ['https://developer.mozilla.org/en-US/docs/Web', 'docs'],
    ['https://developers.google.com/search', 'docs'],
    ['https://requests.readthedocs.io/en/latest/', 'docs'],
    ['https://docs.rs/serde', 'docs'],
    ['https://nodejs.org/docs/latest/api/', 'docs'],
    ['https://kubernetes.io/ja/docs/concepts/', 'docs'],
    ['https://developer.com/article', 'unknown'],
    ['https://docs.com/', 'unknown'],
    ['https://en.wikipedia.org/wiki/RRF', 'reference'],
    ['https://www.reuters.com/technology/x', 'news'],
    ['https://www.bbc.co.uk/news/x', 'news'],
    ['https://medium.com/@dev/post', 'blog'],
    ['https://dev.medium.com/post', 'blog'],
    ['https://dev.to/someone/post', 'blog'],
    ['https://someone.substack.com/p/x', 'blog'],
    ['https://blog.rust-lang.org/2024/x', 'blog'],
    ['https://example.com/blog/post', 'blog'],
    ['https://example.com/en/blog/post', 'blog'],
    ['https://example.com/blogging-tips', 'unknown'],
    ['https://example.com/', 'unknown'],
    ['mailto:x@y.z', 'unknown'],
  ])('%s → %s', (url, type) => {
    expect(classifySource(url, noLists)).toBe(type)
  })

  it('does not match look-alike hosts (label boundary)', () => {
    expect(classifySource('https://notgithub.com/a/b', noLists)).toBe('unknown')
    expect(classifySource('https://stackoverflow.com.evil.com/q/1', noLists)).toBe('unknown')
    expect(classifySource('https://fakereddit.com/r/x', noLists)).toBe('unknown')
  })
})

describe('classifySource: typed lists come first', () => {
  const lists = (map: Record<string, ListKind[]>): SourceTypeDeps => ({
    typedLists: (host) => map[host] ?? [],
  })

  it('official list beats every pattern', () => {
    expect(classifySource('https://medium.com/@react/x', lists({ 'medium.com': ['official'] }))).toBe(
      'official',
    )
    expect(explainSource('https://react.dev/learn', lists({ 'react.dev': ['official'] }))).toEqual({
      type: 'official',
      basis: 'list:official',
    })
  })

  it('content-farm and clone lists give content_farm', () => {
    expect(classifySource('https://dev.to/x', lists({ 'dev.to': ['content-farm'] }))).toBe('content_farm')
    expect(classifySource('https://so-clone.example/q', lists({ 'so-clone.example': ['clone'] }))).toBe(
      'content_farm',
    )
  })

  it('official wins over content-farm when a host is on both', () => {
    expect(classifySource('https://x.example/', lists({ 'x.example': ['content-farm', 'official'] }))).toBe(
      'official',
    )
  })

  it('block and allow lists say nothing about type', () => {
    expect(classifySource('https://dev.to/x', lists({ 'dev.to': ['block', 'allow'] }))).toBe('blog')
  })

  it('passes the normalised host to the list lookup', () => {
    const seen: string[] = []
    classifySource('https://WWW.Bücher.de./x', {
      typedLists: (h) => {
        seen.push(h)
        return []
      },
    })
    expect(seen).toEqual(['www.xn--bcher-kva.de'])
  })
})

describe('pattern table', () => {
  it('explains which row matched', () => {
    expect(explainSource('https://docs.python.org/3/', noLists)).toEqual({
      type: 'docs',
      basis: 'pattern:docs-hosts',
    })
    expect(explainSource('https://example.com/', noLists)).toEqual({ type: 'unknown', basis: 'none' })
  })

  it('is data: rows have unique names and can be replaced', () => {
    const names = SOURCE_PATTERNS.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
    expect(
      classifyByPattern('example.com', '/', [{ name: 'all', type: 'news', domains: ['example.com'] }])?.type,
    ).toBe('news')
  })
})
