/**
 * Every refusal the engine makes is a DrawError with a stable code.
 * Codes are part of the contract; messages are for people.
 */
export class DrawError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'DrawError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const HTTP_STATUS = Object.freeze({
  UNAUTHENTICATED: 401,
  CLIENT_TENANT_ID_REJECTED: 400,
  VALIDATION: 400,
  NOT_FOUND: 404,
  ROLE_REQUIRED: 403,
  SERVICE_ACCOUNT_CANNOT_APPROVE: 403,
  SOD_SELF_APPROVAL: 403,
  SOD_DUPLICATE_APPROVER: 403,
  SOD_APPROVER_CANNOT_INSTRUCT: 403,
  SOD_REQUESTER_CANNOT_INSTRUCT: 403,
  SOD_CSV_SAME_PERSON: 403,
  ILLEGAL_TRANSITION: 409,
  EVIDENCE_LOCKED: 409,
  BINDING_BROKEN: 409,
  CSV_ENTRY_MISMATCH: 409,
  POLICY_PACK_UNKNOWN: 500,
});
