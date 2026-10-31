# search-hole in any other MCP app

Any app that can start a local (stdio) MCP server can run search-hole.

## Quickstart (about 60 seconds)

You need Node.js 22.19+ (`node --version`), the `searchhole` command and an engine. See [Before you start](README.md#before-you-start-every-app-except-claude-code).

1. Print the entry for your app:

   ```sh
   searchhole setup generic
   ```

   It prints this, with the path of your copy, and writes nothing:

   ```json
   {
     "mcpServers": {
       "search-hole": {
         "command": "node",
         "args": ["/path/to/search-hole/dist/searchhole.mjs", "mcp", "--host", "generic"]
       }
     }
   }
   ```

2. Paste it into your app's MCP server settings. Most apps use this `mcpServers` shape; some want the command and the arguments in separate fields. Restart the app.
3. Ask for something that needs the web, naming search-hole. Then run `searchhole log` or `searchhole ui --open` to see the search.

If the app wants a single command line: `node "/path/to/search-hole/dist/searchhole.mjs" mcp --host generic`.

## What works here

| | |
|---|---|
| Host profile | `generic` |
| Tools for the model | `search`, `fetch`, `receipt`, `suggest_rule` |
| Hooks | None |
| Receipt panel | If the app renders MCP Apps, the card shows. There are no buttons on this profile; the card shows commands instead. |
| Protocol | search-hole speaks MCP 2026-07-28 and the 2025 versions, so older and newer apps both work. |

## Keys

Use the keychain, which works without any app support:

```sh
searchhole keys set tavily
```

If your app can pass environment variables to a server, search-hole also reads `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY` and the like from its environment. Keep the key itself out of the app's config file.

## Uninstall

Remove the `search-hole` entry from your app's settings. Your log, rules and stored keys stay until you run `searchhole uninstall --purge`.
