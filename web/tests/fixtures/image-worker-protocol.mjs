// Parent/child protocol test, NOT a decoder. Return success only for a minimal clean env.
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks);
// macOS may initialize its own text-encoding variable even for an empty spawn environment.
const allowed = ['NODE_ENV', 'UV_THREADPOOL_SIZE', 'VIPS_CONCURRENCY', ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [])];
if (Object.keys(process.env).some(key => !allowed.includes(key))) process.exitCode = 3;
else if (input[0] === 137) process.stdout.write('x'.repeat(2048));
else process.stdout.write(JSON.stringify({ format: 'jpeg', width: 32, height: 24 }));
