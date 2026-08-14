```markdown
# DIBS Capital Autopilot — Controlled Draws

**Capital cannot move until the right policy, evidence, approvals, and covenant checks are satisfied.**

This repository holds the architecture and research scaffold for **DIBS Capital Autopilot**, a multi-tenant, policy-enforced capital-control platform focused on controlled-draw workflows for private lenders, construction lenders, debt funds, real-estate sponsors, fund administrators, and deal-specific SPVs.

---

## Core Documents

| Document | Description |
|----------|-------------|
| [`DIBS-Capital-Autopilot.md`](./DIBS-Capital-Autopilot.md) | Full product & architecture specification: state machines, data model, policy engine, evidence, covenants, settlements, audit ledger, SPV Factory, Base44 Super Agents, post-quantum security, Quantum Optimization Lab, repository layout, API design, security controls, pilot plan, and roadmap. |
| [`docs/QUANTUM-AND-PQC-SCAFFOLD.md`](./docs/QUANTUM-AND-PQC-SCAFFOLD.md) | Consolidated research scaffold covering QAOA/QUBO, constraint-preserving XY-mixers, Dicke-state preparation, ML-KEM/ML-DSA, HQC, BIKE (BGF decoder, DFR, absorbing sets), QCSD hardness, parameter tables, and integration roadmap. |

---

## Core Invariant

```text
No capital-state change without:
  policy
  + evidence
  + authorization
  + settlement confirmation
  + reconciliation
  + immutable audit event
```

---

## Controlled-Draw State Machine (MVP)

```text
DRAFT
  → SUBMITTED
  → UNDER_REVIEW
  → HELD
  → APPROVED
  → SETTLEMENT_INSTRUCTED
  → SETTLEMENT_CONFIRMED
  → RECONCILED
  → CLOSED
```

---

## Status

- Architecture and MVP specification
- Quantum Optimization Lab and Post-Quantum Cryptography research scaffold complete
- **Deployment rule:** Do not use production capital, custody, tokenization, insurance, securities, lending, QOF/QOZ, or DeFi workflows until applicable legal, tax, compliance, security, servicing, custody, and independent-review gates are satisfied.

---

## Related Repository

The broader monorepo and implementation work lives at:  
[dibs-financial/dibs-trust-capital-network](https://github.com/dibs-financial/dibs-trust-capital-network)

---

## License & Contributing

See the parent project for contribution guidelines, security policy, and compliance notice.
```

Copy the block above into the GitHub README editor (or save it as `README.md`) for  
`https://github.com/dibs-financial/DIBS-Capital-Autopilot-Controlled-Draws`.
