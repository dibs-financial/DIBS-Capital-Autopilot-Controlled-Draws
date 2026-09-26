# Threat model

Scope: the Track A engine and its dev HTTP surface. Asset: the decision to let capital move, and the record of that decision.

| # | Threat | Actor | Control in this tree | Test |
|---|---|---|---|---|
| T1 | Read or act on another lender's draw | any tenant user | tenant comes from session only; per-tenant spaces; uniform `NOT_FOUND` | `cross-tenant access denied` |
| T2 | Smuggle a tenant id in the request | client | any `tenantId` / `tenant_id` key at any depth throws | `client-supplied tenantId rejected` |
| T3 | Sponsor approves own draw | insider | `SOD_SELF_APPROVAL` | `self-approval blocked` |
| T4 | Automation approves | compromised bot | human-only approval | `service-account approval blocked` |
| T5 | One person clears a large draw | insider | dual control at or above deal threshold; duplicate approver refused | `dual control: $300,000…` |
| T6 | Approver also releases funds | insider | instructor disjoint from requester and approvers | `approver cannot instruct settlement` |
| T7 | Client inflates the payable amount | client / approver | eligible computed from budget and retainage server-side; approve takes no controls | `eligible amount is computed…` |
| T8 | Swap an invoice or bank account after approval | sponsor / insider | binding hash covers manifest and payee account; break returns to review | `binding break…` |
| T9 | New bank account used immediately | fraudster | 24h payee cooling | `payee cooling and stale sanctions…` |
| T10 | Pay a sanctioned party | — | sanctions screen must be ≤ 30 days old at submit and at approve | same |
| T11 | Stale or missing evidence | sponsor | required types, freshness, manifest freeze, supersede-only | `missing inspection…`, `stale required evidence…` |
| T12 | Partner reports a different amount or account | partner error / fraud | reconciliation exception; close is illegal | `confirmation amount mismatch…` |
| T13 | One person keys a fake manual confirmation | insider | CSV dual entry by two different people; mismatch discards both | `CSV dual-entry…` |
| T14 | Rewrite history | insider with DB access | per-tenant hash chain; `verify()` finds the first broken link | `audit verify() detects tampering` |
| T15 | Float rounding in money | developer | bigint minor units; floats rejected | `money is integer minor units…` |

## Out of scope here

- Authentication strength, session theft, and MFA belong to the identity provider.
- A database administrator can still drop the whole chain. Anchor the chain head externally (for example, a daily signed head to a separate account) in production.
- Evidence authenticity: a hash proves the bytes did not change after ingest, not that the document is genuine.
- The dev server has no TLS, rate limiting, or CSRF protection. It binds to `127.0.0.1` only.
