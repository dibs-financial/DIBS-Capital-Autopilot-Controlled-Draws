import { deepFreeze, hashOf } from './util.js';

export const GENESIS_HASH = '0'.repeat(64);

function eventHash(event) {
  const { hash: _omit, ...body } = event;
  return hashOf(body);
}

/**
 * Append-only, per-tenant, hash-chained audit log.
 * The engine appends an event *before* it mutates state; if the append
 * throws, nothing changes.
 */
export class AuditLog {
  #chains = new Map();

  append({ tenantId, actorId, type, drawId = null, dealId = null, from = null, to = null, data = {}, at }) {
    if (!tenantId) throw new Error('audit: tenantId required');
    const chain = this.#chains.get(tenantId) ?? [];
    const prev = chain.at(-1);
    const body = {
      seq: chain.length + 1,
      tenantId,
      at: at.toISOString(),
      actorId,
      type,
      drawId,
      dealId,
      from,
      to,
      data: structuredClone(data),
      prevHash: prev ? prev.hash : GENESIS_HASH,
    };
    const event = deepFreeze({ ...body, hash: hashOf(body) });
    chain.push(event);
    this.#chains.set(tenantId, chain);
    return event;
  }

  events(tenantId, { drawId } = {}) {
    const chain = this.#chains.get(tenantId) ?? [];
    return drawId ? chain.filter((e) => e.drawId === drawId) : [...chain];
  }

  verify(tenantId) {
    return AuditLog.verifyEvents(this.#chains.get(tenantId) ?? []);
  }

  /** Recompute every link. Works on any exported copy of a chain. */
  static verifyEvents(events) {
    let prevHash = GENESIS_HASH;
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i];
      if (e.seq !== i + 1) return { ok: false, length: events.length, brokenAt: i + 1, reason: 'sequence gap' };
      if (e.prevHash !== prevHash) return { ok: false, length: events.length, brokenAt: e.seq, reason: 'prevHash mismatch' };
      if (eventHash(e) !== e.hash) return { ok: false, length: events.length, brokenAt: e.seq, reason: 'hash mismatch' };
      prevHash = e.hash;
    }
    return { ok: true, length: events.length, head: prevHash };
  }
}
