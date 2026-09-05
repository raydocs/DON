export function selectBulkDeletable<T extends { id: string }>(
  items: T[],
  usage: Record<string, number>,
): T[] {
  return items.filter((item) => (usage[item.id] ?? 0) === 0);
}
