/** Source RPC logIndex is block-global. It orders transactions and logs within each block;
 * ASC uses the equivalent (blockHeight, transactionIndex, receipt-local logIndex) ordering. */
export function newestPerSubject<T extends { subject: string; blockNumber: number; logIndex: number }>(all: Map<string, T>): Map<string, T> {
  const latest = new Map<string, T>();
  for (const candidate of all.values()) {
    const previous = latest.get(candidate.subject);
    if (!previous || candidate.blockNumber > previous.blockNumber
      || (candidate.blockNumber === previous.blockNumber && candidate.logIndex > previous.logIndex)) latest.set(candidate.subject, candidate);
  }
  return latest;
}
