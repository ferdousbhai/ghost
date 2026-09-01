const VERSION_LINE = /^systemd[ \t]+([0-9]{1,5})(?:[ \t]|$)/u;

export function parseSupportedSystemdMajor(source: string): number | undefined {
  const firstNewline = source.indexOf("\n");
  const firstLine = firstNewline < 0 ? source : source.slice(0, firstNewline);
  const match = VERSION_LINE.exec(firstLine);
  if (!match) return undefined;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) && major >= 254 ? major : undefined;
}
