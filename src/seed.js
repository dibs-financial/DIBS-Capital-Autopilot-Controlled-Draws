import { usd } from './money.js';
import { DAY_MS } from './util.js';

export const ACME = 'tenant-acme-lending';
export const GLOBEX = 'tenant-globex-credit';

const human = (id, tenantId, roles, name) => ({ id, tenantId, roles, kind: 'human', name });
const service = (id, tenantId, roles, name) => ({ id, tenantId, roles, kind: 'service', name });

/** Actors normally come from the identity provider. These are fixtures. */
export const ACTORS = Object.freeze({
  sponsor: human('usr_sponsor_dana', ACME, ['Sponsor'], 'Dana Ortiz (sponsor)'),
  risk: human('usr_risk_sam', ACME, ['RiskOwner'], 'Sam Lee (risk owner)'),
  underwriter: human('usr_uw_priya', ACME, ['Underwriter'], 'Priya Nair (underwriter)'),
  admin: human('usr_admin_jo', ACME, ['LenderAdmin'], 'Jo Park (lender admin)'),
  treasury: human('usr_treasury_ali', ACME, ['TreasuryOwner'], 'Ali Chen (treasury)'),
  treasury2: human('usr_treasury_mo', ACME, ['TreasuryOwner'], 'Mo Diaz (treasury)'),
  dualHat: human('usr_dualhat_kim', ACME, ['RiskOwner', 'TreasuryOwner'], 'Kim Ross (risk + treasury)'),
  sponsorRisk: human('usr_sponsorrisk_lee', ACME, ['Sponsor', 'RiskOwner'], 'Lee Grant (sponsor + risk)'),
  riskBot: service('svc_riskbot', ACME, ['RiskOwner'], 'Risk scoring bot'),
  partner: service('svc_partner_bank', ACME, ['SettlementPartner'], 'Settlement partner integration'),
  globexSponsor: human('usr_globex_sponsor', GLOBEX, ['Sponsor'], 'Globex sponsor'),
  globexAdmin: human('usr_globex_admin', GLOBEX, ['LenderAdmin'], 'Globex admin'),
});

export const sessionFor = (actor) => ({ actor });

/**
 * One construction deal with an aged payee (past cooling, recently screened).
 * The clock is rewound to set up history, then left frozen at `at`.
 */
export function seedDeal(engine, clock, at = new Date('2026-09-26T15:00:00Z')) {
  clock.freeze(at.getTime() - 3 * DAY_MS);
  const admin = sessionFor(ACTORS.admin);
  const deal = engine.createDeal(admin, {
    name: 'Maple Street Mixed-Use',
    commitmentMinor: usd(2_000_000),
    dualControlThresholdMinor: usd(250_000),
    retainageBps: 1_000,
    maturityDate: '2027-12-31T00:00:00Z',
    budgetLines: [
      { code: 'SITEWORK', description: 'Site work & foundation', budgetMinor: usd(400_000) },
      { code: 'FRAMING', description: 'Framing & envelope', budgetMinor: usd(600_000) },
      { code: 'MEP', description: 'Mechanical, electrical, plumbing', budgetMinor: usd(500_000) },
      { code: 'FINISHES', description: 'Interior finishes', budgetMinor: usd(500_000) },
    ],
  });
  const payee = engine.addPayee(admin, deal.id, {
    name: 'Ridgeline Builders LLC',
    accountFingerprint: 'acct:ridgeline:****4417',
    sanctionsScreenedAt: new Date(at.getTime() - 5 * DAY_MS).toISOString(),
  });

  const globexDeal = engine.createDeal(sessionFor(ACTORS.globexAdmin), {
    name: 'Globex Warehouse Retrofit',
    commitmentMinor: usd(1_000_000),
    dualControlThresholdMinor: usd(250_000),
    retainageBps: 500,
    budgetLines: [{ code: 'SHELL', budgetMinor: usd(1_000_000) }],
  });
  clock.freeze(at);
  return { deal, payee, globexDeal };
}

/** Standard evidence set, collected two days before `now`. */
export function standardEvidence(now, types = ['INVOICE', 'INSPECTION_REPORT', 'LIEN_WAIVER']) {
  const collectedAt = new Date(now.getTime() - 2 * DAY_MS).toISOString();
  return types.map((type) => ({
    type,
    content: `${type} for Maple Street — ${collectedAt}`,
    collectedAt,
    fileName: `${type.toLowerCase()}.pdf`,
  }));
}
