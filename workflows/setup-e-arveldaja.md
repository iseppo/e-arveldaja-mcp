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
   - importing a secure `apikey*.txt` file
<!-- E_ARVELDAJA_FEATURE_START:credential-tools -->
4. `import_apikey_credentials` is preview-first: the default call verifies and projects the target without writing and returns a `plan_handle`; persist by calling it again with `execute: true` and that `plan_handle`. Use it only after the user identifies the file or confirms the detected single candidate. Prefer the `setup-credentials` workflow, which covers the full preview→execute flow, storage scope, and removal.
<!-- E_ARVELDAJA_FEATURE_END:credential-tools -->
<!-- E_ARVELDAJA_FEATURE_START:no-credential-tools -->
4. The credential-import tool is not registered on this server's current tool surface (it appears in `setup` mode on the `standard`/`full` profiles, or with `EARVELDAJA_EXPOSE_SETUP_TOOLS=1`). `get_setup_instructions` is never gated. On `EARVELDAJA_PROFILE=guided` / `guided-sales`, add the credentials through the environment variables or a local or shared `.env` file (no profile change needed), or — to import an `apikey*.txt` file from a tool call — start the server temporarily with `EARVELDAJA_PROFILE=full` (it includes the credential tools) and switch back to the guided profile afterwards. Do NOT suggest `EARVELDAJA_EXPOSE_SETUP_TOOLS=1` there: setting any legacy exposure flag switches the profile to `custom` and replaces the guided tool surface. On the `standard` profile, restarting with `EARVELDAJA_EXPOSE_SETUP_TOOLS=1` adds the import tool (the profile then normalizes to `custom`: the standard tool set plus the credential tools), as does `EARVELDAJA_PROFILE=full`. Follow the `next_steps` from `get_setup_instructions`, which already names the right path for the running profile.
<!-- E_ARVELDAJA_FEATURE_END:no-credential-tools -->
5. After a successful import, state that the MCP server must be restarted before the stored credentials become active.
