export function formatLoopbackHost(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host;
  return host.includes(":") ? `[${host}]` : host;
}

export function formatLoopbackOrigin(host: string, port: number): string {
  return `http://${formatLoopbackHost(host)}:${port}`;
}
