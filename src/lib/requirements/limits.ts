/**
 * Size limits shared by the form and the persistence layer.
 *
 * Their own module because the browser needs them: importing a constant from the
 * service would drag Prisma (and its `pg` driver) into the client bundle, which
 * fails the build rather than merely bloating it.
 */

/**
 * The longest requirement we accept. Postgres `text` has no practical ceiling,
 * so this is a product limit, not a storage one: past roughly this length the
 * model's context — not the database — is the binding constraint.
 */
export const REQUIREMENT_TEXT_MAX_LENGTH = 20_000;
