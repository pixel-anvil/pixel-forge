// Placeholder for scripts that are filled in by later cards.
const notes = {
  bench: 'benchmarks are not implemented yet (report-only, never fails the build)',
};
const name = process.argv[2] ?? '';
console.log(`[${name}] placeholder: ${notes[name] ?? 'not implemented'}`);
