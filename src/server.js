#!/usr/bin/env node
// Minimal HTTP surface over the engine. Dev only: identity is the x-actor header.
import { createServer } from 'node:http';
import { ControlledDrawEngine } from './engine.js';
import { Clock } from './clock.js';
import { DrawError, HTTP_STATUS } from './errors.js';
import { ACTORS, seedDeal, sessionFor } from './seed.js';

const DEV_ACTORS = {
  sponsor: ACTORS.sponsor,
  risk: ACTORS.risk,
  underwriter: ACTORS.underwriter,
  admin: ACTORS.admin,
  treasury: ACTORS.treasury,
  treasury2: ACTORS.treasury2,
  partner: ACTORS.partner,
};

export function createApp({ engine }) {
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  };

  const readBody = async (req) => {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1_000_000) throw new DrawError('VALIDATION', 'Body too large');
    }
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new DrawError('VALIDATION', 'Body must be JSON');
    }
  };

  const routes = [
    ['GET', /^\/draws$/, (s) => engine.listDraws(s)],
    ['POST', /^\/draws$/, (s, _m, b) => engine.createDraw(s, b)],
    ['GET', /^\/draws\/([\w-]+)$/, (s, m) => engine.getDraw(s, m[1])],
    ['GET', /^\/draws\/([\w-]+)\/desk$/, (s, m) => engine.desk(s, m[1])],
    ['GET', /^\/draws\/([\w-]+)\/audit$/, (s, m) => engine.auditTrail(s, { drawId: m[1] })],
    ['POST', /^\/draws\/([\w-]+)\/amend$/, (s, m, b) => engine.amendDraw(s, m[1], b)],
    ['POST', /^\/draws\/([\w-]+)\/evidence$/, (s, m, b) => engine.attachEvidence(s, m[1], b)],
    ['POST', /^\/draws\/([\w-]+)\/evidence\/([\w-]+)\/supersede$/, (s, m, b) => engine.supersedeEvidence(s, m[1], m[2], b)],
    ['POST', /^\/draws\/([\w-]+)\/submit$/, (s, m) => engine.submit(s, m[1])],
    // Approve ignores the body entirely: controls are computed server-side.
    ['POST', /^\/draws\/([\w-]+)\/approve$/, (s, m) => engine.approve(s, m[1])],
    ['POST', /^\/draws\/([\w-]+)\/break-binding$/, (s, m, b) => engine.breakBinding(s, m[1], b)],
    ['POST', /^\/draws\/([\w-]+)\/instruct$/, (s, m) => engine.instructSettlement(s, m[1])],
    ['POST', /^\/draws\/([\w-]+)\/confirm$/, (s, m, b) => engine.recordPartnerConfirmation(s, m[1], b)],
    ['POST', /^\/draws\/([\w-]+)\/csv-confirm$/, (s, m, b) => engine.enterCsvConfirmation(s, m[1], b)],
    ['POST', /^\/draws\/([\w-]+)\/close$/, (s, m) => engine.close(s, m[1])],
    ['GET', /^\/deals\/([\w-]+)$/, (s, m) => engine.getDeal(s, m[1])],
    ['GET', /^\/audit$/, (s) => engine.auditTrail(s)],
    ['GET', /^\/audit\/verify$/, (s) => engine.verifyAudit(s)],
  ];

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
      const actor = DEV_ACTORS[req.headers['x-actor']];
      if (!actor) throw new DrawError('UNAUTHENTICATED', `x-actor must be one of: ${Object.keys(DEV_ACTORS).join(', ')}`);
      const route = routes.find(([method, re]) => method === req.method && re.test(url.pathname));
      if (!route) return json(res, 404, { error: 'NOT_FOUND', message: 'No such route' });
      const body = req.method === 'POST' ? await readBody(req) : {};
      const result = route[2](sessionFor(actor), url.pathname.match(route[1]), body);
      return json(res, 200, result);
    } catch (e) {
      if (e instanceof DrawError) return json(res, HTTP_STATUS[e.code] ?? 400, { error: e.code, message: e.message });
      console.error(e);
      return json(res, 500, { error: 'INTERNAL', message: 'Internal error' });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const clock = new Clock();
  const engine = new ControlledDrawEngine({ now: clock.now });
  const { deal, payee } = seedDeal(engine, clock, new Date());
  clock.release();
  const port = Number(process.env.PORT ?? 8787);
  createApp({ engine }).listen(port, '127.0.0.1', () => {
    console.log(`DIBS controlled draws on http://127.0.0.1:${port}`);
    console.log(`  x-actor: ${Object.keys(DEV_ACTORS).join(' | ')}`);
    console.log(`  deal  ${deal.id}  (${deal.name})`);
    console.log(`  payee ${payee.id}  (${payee.name})`);
  });
}
