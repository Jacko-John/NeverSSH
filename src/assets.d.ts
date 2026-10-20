/** Bun embeds the ephemeral remote helper as text in both source and bundled builds. */
declare module "*.py" {
  const source: string;
  export default source;
}
