/**
 * Branch names are far more permissive than DNS labels — `feat/ABC-123_Fix Thing`
 * is a legal branch and an illegal hostname. Every branch therefore gets a slug
 * that is safe as a hostname, a container name, and a Traefik router id.
 */
export function slugify(input: string, maxLength = 40): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  const trimmed = base.length > maxLength ? base.slice(0, maxLength).replace(/-+$/g, '') : base
  const safe = trimmed || 'branch'

  // A leading digit is legal in modern DNS but trips some resolvers and Traefik
  // rule parsing, so prefix it.
  return /^[0-9]/.test(safe) ? `b-${safe}` : safe
}

/**
 * A slug is baked into a hostname and a container name, so it must be *stable*
 * for a given branch — not dependent on insertion order or on what else exists.
 * Two branches can still collapse to the same text (`feat/a-b` vs `feat/a_b`);
 * only in that case do we disambiguate, by hashing the branch name itself.
 */
export function slugFor(branch: string, allBranches: Iterable<string>): string {
  const base = slugify(branch)
  let collisions = 0
  for (const other of allBranches) {
    if (slugify(other) === base) collisions++
    if (collisions > 1) break
  }
  return collisions > 1 ? `${base}-${shortHash(branch)}` : base
}

export function shortHash(input: string): string {
  // FNV-1a, base36. Deterministic and short; not security-relevant.
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36).slice(0, 5)
}
