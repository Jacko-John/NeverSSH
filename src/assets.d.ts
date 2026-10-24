/** Bun embeds every remote Python source as text in source and bundled builds. */
declare module "*.py" {
  const source: string;
  export default source;
}
