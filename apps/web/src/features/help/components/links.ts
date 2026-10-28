/** Placeholders do mock (`[LINK]`) não viram link clicável. */
export function isRealLink(url: string) {
  return url.startsWith("https://") || url.startsWith("/");
}
