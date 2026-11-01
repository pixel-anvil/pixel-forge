declare const __PF_VERSION__: string | undefined;

/**
 * The `pf` version: `version` of `packages/cli/package.json`, inlined by the bundler at build time
 * (`tsup.config.ts`). Unbundled code (tests, `tsc` output) reports `0.0.0-dev`.
 */
export const VERSION: string = typeof __PF_VERSION__ === 'string' ? __PF_VERSION__ : '0.0.0-dev';
