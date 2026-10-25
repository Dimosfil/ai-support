export class SupportError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function requireThat(condition, code, status = 400) {
  if (!condition) throw new SupportError(code, status);
}

export function text(value, maximum, code) {
  requireThat(typeof value === 'string', code);
  const result = value.trim();
  requireThat(result.length > 0 && result.length <= maximum, code);
  return result;
}

export function identity(principal) {
  requireThat(principal && ['user', 'operator'].includes(principal.role), 'unauthorized', 401);
  for (const field of ['tenant', 'subject'])
    requireThat(principal[field] === text(principal[field], 128, 'unauthorized'), 'unauthorized', 401);
  return Object.freeze({ tenant: principal.tenant, subject: principal.subject, role: principal.role });
}

export function canRead(principal, ticket) {
  // Tenant scope is enforced in storage as well as at this boundary.
  requireThat(ticket && ticket.tenant === principal.tenant &&
    (principal.role === 'operator' || ticket.owner === principal.subject), 'not_found', 404);
}

export function operator(principal) {
  requireThat(principal.role === 'operator', 'forbidden', 403);
}

export function expectedVersion(value) {
  requireThat(Number.isSafeInteger(value) && value > 0, 'version_required');
  return value;
}

export const statuses = Object.freeze(['new', 'in_progress', 'waiting_user', 'resolved']);
export const statusTransitions = Object.freeze({
  new: Object.freeze(['in_progress', 'resolved']),
  in_progress: Object.freeze(['waiting_user', 'resolved']),
  waiting_user: Object.freeze(['in_progress', 'resolved']),
  resolved: Object.freeze(['in_progress']),
});
export function nextStatus(current, requested) {
  requireThat(statusTransitions[current]?.includes(requested), 'invalid_transition', 409);
  return requested;
}

export function pageOptions({ before, limit = 30 } = {}) {
  requireThat(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'invalid_limit');
  requireThat(before === undefined || (Number.isSafeInteger(before) && before > 0), 'invalid_cursor');
  return { before: before ?? Number.MAX_SAFE_INTEGER, limit };
}
