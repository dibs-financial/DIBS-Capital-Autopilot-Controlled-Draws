import { DrawError } from './errors.js';
import { hashOf, sha256Hex, toDate } from './util.js';

const TYPE_RE = /^[A-Z][A-Z_]{1,39}$/;

/** Hash on ingest. The engine stores the digest, never trusts a client-supplied one. */
export function ingestEvidence({ input, actor, now, id }) {
  const { type, content, collectedAt, fileName = null } = input ?? {};
  if (typeof type !== 'string' || !TYPE_RE.test(type)) {
    throw new DrawError('VALIDATION', 'evidence type must be an UPPER_SNAKE token, e.g. INSPECTION_REPORT');
  }
  const bytes =
    typeof content === 'string' ? Buffer.from(content, 'utf8') : content instanceof Uint8Array ? Buffer.from(content) : null;
  if (!bytes || bytes.length === 0) throw new DrawError('VALIDATION', 'evidence content is required');
  let collected;
  try {
    collected = toDate(collectedAt, 'collectedAt');
  } catch (e) {
    throw new DrawError('VALIDATION', e.message);
  }
  if (collected.getTime() > now.getTime()) throw new DrawError('VALIDATION', 'collectedAt cannot be in the future');
  return {
    id,
    type,
    fileName,
    sha256: sha256Hex(bytes),
    sizeBytes: bytes.length,
    collectedAt: collected.toISOString(),
    ingestedAt: now.toISOString(),
    ingestedBy: actor.id,
    supersedes: null,
    supersededBy: null,
  };
}

/** The manifest is the set of active (non-superseded) evidence, frozen at submit. */
export function freezeManifest(evidence) {
  const manifest = evidence
    .filter((e) => e.supersededBy === null)
    .map(({ id, type, sha256, collectedAt }) => ({ id, type, sha256, collectedAt }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { manifest, manifestHash: hashOf(manifest) };
}
