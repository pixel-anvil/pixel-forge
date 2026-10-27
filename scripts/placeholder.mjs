// Placeholder for scripts that are filled in by later cards.
const notes = {
  gen: 'generators are filled by T5.1',
  'gen:check': 'generated-artifact freshness check is filled by T5.1',
  bench: 'benchmarks are not implemented yet (report-only, never fails the build)',
};
const name = process.argv[2] ?? '';
console.log(`[${name}] placeholder: ${notes[name] ?? 'not implemented'}`);
