import { describe, expect, it } from 'vitest'
import { shortHash, slugFor, slugify } from '../../src/slug.js'

/** A slug becomes a DNS label, so it must satisfy the same constraints. */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

describe('slugify', () => {
  it('lowercases and replaces path separators', () => {
    expect(slugify('feature/new-header')).toBe('feature-new-header')
    expect(slugify('FEAT/ABC-123_Fix Thing')).toBe('feat-abc-123-fix-thing')
  })

  it('collapses runs of separators and trims the edges', () => {
    expect(slugify('a///b')).toBe('a-b')
    expect(slugify('--lead-and-trail--')).toBe('lead-and-trail')
    expect(slugify('release/2.0')).toBe('release-2-0')
  })

  it('prefixes a leading digit', () => {
    // Legal in modern DNS, but it trips some resolvers and Traefik rule parsing.
    expect(slugFor('2024-hotfix', ['2024-hotfix'])).toBe('b-2024-hotfix')
    expect(slugify('2024-hotfix')).toBe('b-2024-hotfix')
  })

  it('never exceeds the DNS label limit', () => {
    const long = `feature/${'x'.repeat(200)}`
    const slug = slugify(long)
    expect(slug.length).toBeLessThanOrEqual(63)
    expect(slug).toMatch(DNS_LABEL)
  })

  it('does not leave a trailing hyphen after truncation', () => {
    const slug = slugify(`feature/${'ab-'.repeat(40)}`)
    expect(slug.endsWith('-')).toBe(false)
    expect(slug).toMatch(DNS_LABEL)
  })

  it('produces a usable slug from input with no alphanumerics', () => {
    expect(slugify('///')).toBe('branch')
    expect(slugify('')).toBe('branch')
  })

  it('handles unicode branch names', () => {
    // Non-ASCII cannot appear in a plain DNS label, so it is stripped; the result
    // must still be valid rather than empty or hyphen-only.
    for (const name of ['feature/日本語', 'fix/café', 'спринт/1', '🚀-launch']) {
      const slug = slugify(name)
      expect(slug).toMatch(DNS_LABEL)
      expect(slug.length).toBeGreaterThan(0)
    }
  })
})

describe('slugFor — stability and collisions', () => {
  it('is stable regardless of what else exists', () => {
    const a = slugFor('feature/x', ['feature/x', 'main', 'other'])
    const b = slugFor('feature/x', ['feature/x'])
    expect(a).toBe(b)
    expect(a).toBe('feature-x')
  })

  it('is independent of ordering in the branch set', () => {
    const set1 = ['main', 'feature/x', 'zeta']
    const set2 = ['zeta', 'main', 'feature/x']
    expect(slugFor('feature/x', set1)).toBe(slugFor('feature/x', set2))
  })

  it('disambiguates genuine collisions deterministically', () => {
    // feat/a-b and feat/a_b both slugify to feat-a-b.
    const branches = ['feat/a-b', 'feat/a_b']
    const first = slugFor('feat/a-b', branches)
    const second = slugFor('feat/a_b', branches)

    expect(first).not.toBe(second)
    expect(first).toMatch(DNS_LABEL)
    expect(second).toMatch(DNS_LABEL)
    // Re-running must give the same answer — the slug is in a URL.
    expect(slugFor('feat/a-b', branches)).toBe(first)
  })

  it('leaves a non-colliding branch un-suffixed', () => {
    expect(slugFor('main', ['main', 'develop'])).toBe('main')
  })
})

describe('shortHash', () => {
  it('is deterministic and compact', () => {
    expect(shortHash('feature/x')).toBe(shortHash('feature/x'))
    expect(shortHash('feature/x').length).toBeLessThanOrEqual(5)
  })

  it('separates inputs that slugify identically', () => {
    expect(shortHash('feat/a-b')).not.toBe(shortHash('feat/a_b'))
  })
})
