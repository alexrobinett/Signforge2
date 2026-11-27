/** The D1 id wrangler.jsonc carries for an environment whose database is not created yet, and dev, which only runs locally. */
export const PLACEHOLDER_D1_ID = '00000000-0000-0000-0000-000000000000';

/** The D1 bindings of a resolved environment that still hold the placeholder id: a deploy of them would run against nothing. */
export function placeholderDatabases(config: { d1_databases?: readonly { binding: string; database_id?: string }[] }): string[] {
  return (config.d1_databases ?? []).filter((d) => d.database_id === PLACEHOLDER_D1_ID).map((d) => d.binding);
}
