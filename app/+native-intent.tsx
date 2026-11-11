// No external link selects a screen or supplies what a screen shows. A link
// that starts the app opens the home route. A link that arrives while the app
// runs changes nothing, so another app cannot interrupt a verification.
// Screens that need context, such as the failure screen, read it from app state.

export function redirectSystemPath(event: { path: string; initial: boolean }): string | null {
  return event.initial ? "/" : null;
}
