// Synthetic process-control fixture; never loads a codec or a credential.
for await (const _chunk of process.stdin) { void _chunk; }
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
