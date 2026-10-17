type Authorization = { clientId: string; name: string };

export function sameAuthorizations(previous: Authorization[], next: Authorization[]) {
  if (previous.length !== next.length) return false;
  const names = new Map(previous.map((client) => [client.clientId, client.name]));
  return next.every((client) => names.get(client.clientId) === client.name);
}

export function authorizationRefreshDelay(
  previous: number,
  { settingUp, changed }: { settingUp: boolean; changed: boolean },
) {
  const minimum = settingUp ? 5000 : 15000;
  return changed ? minimum : Math.min(60000, Math.max(previous, minimum) * 2);
}
