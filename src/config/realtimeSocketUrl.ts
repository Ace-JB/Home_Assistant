type RealtimeLocation = Pick<Location, 'protocol' | 'hostname' | 'port'>;

export function resolveRealtimeSocketUrl(
  location: RealtimeLocation,
  configuredSocketUrl?: string,
): string {
  const configured = configuredSocketUrl?.trim();
  if (configured) return configured;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const currentPort = Number(location.port || (location.protocol === 'https:' ? 443 : 80));
  return `${protocol}//${location.hostname}:${currentPort + 1}/ws/realtime`;
}
