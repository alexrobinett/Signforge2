/**
 * An agent's OAuth client in words, as `/connect` and Settings › Connected agents (MCP) name it. The API sends
 * an unverified client's name only when a page may show it (`shownClient` in `@signforge/tools`):
 * otherwise `name` is null and the client is an unverified app at where its code goes. `<bdi>` keeps
 * a name from reordering the text around it; a long one wraps rather than widen the page.
 */
import type { ConnectRequest } from '~/lib/connect';

type Client = ConnectRequest['client'];

const NAME_WRAP = '[overflow-wrap:anywhere]';

/** Where its code goes: a web host, an app's own scheme, or null when that is withheld too. */
const whereOf = (client: Client) => (client.redirect.kind === 'web' ? client.redirect.host : client.redirect.target);

/**
 * The client in a sentence: SignForge's own by its name; another by its name in quotes, as only its
 * claim; and one whose name is withheld as "this app" (a heading or a row says where its code goes).
 */
export function ClientName({ client }: { client: Client }) {
  if (client.verified) return <bdi className={NAME_WRAP}>{client.name}</bdi>;
  if (client.name === null) return <>this app</>;
  return (
    <>
      “<bdi className={NAME_WRAP}>{client.name}</bdi>”
    </>
  );
}

/** The client on its own, as a heading or a row names it: a withheld name as an unverified app at where its code goes. */
export function AgentName({ client }: { client: Client }) {
  if (client.name !== null) return <ClientName client={client} />;
  const where = whereOf(client);
  return (
    <>
      An unverified app{' '}
      {where === null ? (
        'on this device'
      ) : (
        <>
          at <span className={`font-mono ${NAME_WRAP}`}>{where}</span>
        </>
      )}
    </>
  );
}
