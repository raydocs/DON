import type { BrowserProfile } from "@/types";

export function upsertProfileById(
  profiles: BrowserProfile[],
  updated: BrowserProfile,
): BrowserProfile[] {
  const index = profiles.findIndex((profile) => profile.id === updated.id);
  if (index < 0) return [...profiles, updated];
  if (profiles[index] === updated) return profiles;
  const next = [...profiles];
  next[index] = updated;
  return next;
}

export interface AssignmentUsageState {
  assignments: Record<string, string | undefined>;
  usage: Record<string, number>;
}

export function updateAssignmentUsage(
  state: AssignmentUsageState,
  profileId: string,
  assignmentId: string | undefined,
): AssignmentUsageState {
  const previousId = state.assignments[profileId];
  if (previousId === assignmentId) return state;

  const assignments = { ...state.assignments, [profileId]: assignmentId };
  const usage = { ...state.usage };
  if (previousId) {
    const remaining = (usage[previousId] ?? 1) - 1;
    if (remaining > 0) usage[previousId] = remaining;
    else delete usage[previousId];
  }
  if (assignmentId) usage[assignmentId] = (usage[assignmentId] ?? 0) + 1;
  return { assignments, usage };
}
