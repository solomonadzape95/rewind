/**
 * Demo constants, kept in their own module on purpose.
 *
 * These used to live in scripts/seed.ts, which meant `import { TENANT } from
 * "./seed"` re-ran the entire seeding routine as a module side effect. Scripts
 * import identifiers from here, never from each other.
 */
export const TENANT = "00000000-0000-0000-0000-0000000000aa";
export const REFUND_POLICY = "policy.refund_limit.enterprise";
