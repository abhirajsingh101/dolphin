export function sessionsInViewLabel(count: number): string {
  return `${count} ${count === 1 ? 'session' : 'sessions'} in view`;
}
