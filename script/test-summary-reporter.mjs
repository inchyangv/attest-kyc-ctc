// Consume Node's test-runner event stream, not TAP-like lines printed by test code.
export default async function* report(events) {
  for await (const event of events) {
    if (event.type === 'test:summary') yield JSON.stringify({ type: event.type, data: event.data }) + '\n';
  }
}
