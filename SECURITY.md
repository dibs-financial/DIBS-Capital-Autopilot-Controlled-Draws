# Security policy

## Status

This is a reference engine. It is **not** approved for production capital. See the deployment rule in `README.md`.

## Reporting

Report suspected vulnerabilities privately to the maintainers through GitHub's **Report a vulnerability** (Security → Advisories) on this repository. Do not open public issues for security problems.

Please include:

- the affected file and function,
- a minimal reproduction (a failing `node:test` case is ideal),
- which invariant it breaks (tenant isolation, SoD, binding, reconciliation, audit).

## Invariants we treat as security bugs

- Any path that changes draw state without an audit event appended first.
- Any read or write across tenants.
- Any way for a client value to set eligible amount, approvals required, or other controls.
- Any way for one person to hold two of: requester, approver, instructor on the same draw.
- Any path from `RECONCILIATION_EXCEPTION` to `CLOSED`.
- Any audit mutation that `verify()` does not detect.

## Secrets

The repository contains no credentials. The `x-actor` header in `src/server.js` is a development stand-in for authentication and must never be exposed beyond localhost.
