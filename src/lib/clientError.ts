/**
 * Which error messages a client is allowed to see (T-53).
 *
 * The rule this enforces: a message reaches the caller only if somebody deliberately wrote it
 * for them. Everything else — an Intuit fault body, a Prisma constraint message, a stack from a
 * library — is logged and replaced.
 *
 * Reflecting raw upstream text is easy to do by accident, because `e.message` reads like the
 * helpful thing to send. It is not. Intuit's fault bodies carry realm ids and the full request
 * echo; Prisma's carry column and constraint names, which is a free map of the schema; and none
 * of it tells the person on site anything they can act on. Meanwhile the messages that ARE
 * useful — "that name already exists in QuickBooks, pick the existing customer" — are ones this
 * codebase wrote on purpose, and those are exactly what `UserFacingError` marks.
 */

/** An error whose message was written for the person who will read it, and is safe to return. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

/**
 * The message to send back. `fallback` is used for anything not explicitly marked user-facing.
 *
 * The caller is expected to log the real error separately — this deliberately returns a string
 * rather than logging, so the log line keeps the request context the caller has and this module
 * does not.
 */
export const clientSafeMessage = (e: unknown, fallback: string): string =>
  e instanceof UserFacingError ? e.message : fallback;
