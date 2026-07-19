# Setup e-arveldaja

Explain how to configure e-arveldaja MCP credentials for the current working directory.

For actual importing, prefer the `setup-credentials` workflow because it covers storage scope, append/overwrite behavior, removal, and restart verification.

Follow these steps:

1. Call `get_setup_instructions`.
2. Report whether the server is in `setup` or `configured` mode.
3. Explain the supported credential paths:
   - `EARVELDAJA_API_KEY_ID`
   - `EARVELDAJA_API_PUBLIC_VALUE`
   - `EARVELDAJA_API_PASSWORD`
   - `EARVELDAJA_API_KEY_FILE`
   - importing a secure `apikey*.txt` with `import_apikey_credentials`
4. The credential-management tools (`import_apikey_credentials`, `list_stored_credentials`, `remove_stored_credentials`) are always registered in `setup` mode. In `configured` mode they are hidden and only appear when the server is started with `EARVELDAJA_EXPOSE_SETUP_TOOLS=1`. `get_setup_instructions` is never gated. If `import_apikey_credentials` is not in `tools/list`, tell the user to restart with `EARVELDAJA_EXPOSE_SETUP_TOOLS=1` (or from the setup folder) and stop.
5. `import_apikey_credentials` is preview-first: the default call verifies and projects the target without writing and returns a `plan_handle`; persist by calling it again with `execute: true` and that `plan_handle`. Use it only after the user identifies the file or confirms the detected single candidate. Prefer the `setup-credentials` workflow, which covers the full preview→execute flow, storage scope, and removal.
6. After a successful import, state that the MCP server must be restarted before the stored credentials become active.
