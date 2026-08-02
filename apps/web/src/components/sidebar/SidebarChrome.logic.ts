export function resolveSidebarProductLabel(appBaseName: string): string {
  const productLabel = /^T3\s+(.+)$/u.exec(appBaseName.trim())?.[1]?.trim();
  return productLabel || "Code";
}
