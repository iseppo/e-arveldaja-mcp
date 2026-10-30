# Setup e-arveldaja

Explain how to configure e-arveldaja MCP credentials for the current working directory.

For actual importing, prefer the `setup-credentials` workflow because it covers storage scope, append/overwrite behavior, removal, and restart verification.

Never read, print, or quote the contents of `apikey*.txt` or `.env` files, and never ask the user to paste the API password or public value into chat; the tools show only `masked_api_key_id`. Never `git add` or commit these files; before storing a local `.env` in a git repository, check that `.env` and `apikey*.txt` are git-ignored.

Follow these steps:

1. Call `get_setup_instructions`.
2. Report whether the server is in `setup` or `configured` mode.
3. Explain the supported credential paths:
   - `EARVELDAJA_API_KEY_ID`
   - `EARVELDAJA_API_PUBLIC_VALUE`
   - `EARVELDAJA_API_PASSWORD`
   - `EARVELDAJA_API_KEY_FILE`
   - a `.env` file in the working directory (local) or in the global config directory (`global_env_file`)
   - importing a secure `apikey*.txt` file
<!-- E_ARVELDAJA_FEATURE_START:credential-tools -->
4. `import_apikey_credentials` is preview-first: the default call verifies and projects the target without writing and returns a `plan_handle`; persist by calling it again with `execute: true` and that `plan_handle`. Use it only after the user identifies the file or confirms the detected single candidate. Prefer the `setup-credentials` workflow, which covers the full preview→execute flow, storage scope, and removal.
<!-- E_ARVELDAJA_FEATURE_END:credential-tools -->
<!-- E_ARVELDAJA_FEATURE_START:no-credential-tools -->
4. The credential-import tool is not registered on this tool surface. Follow the `next_steps` from `get_setup_instructions`, which name the right way to add credentials for the running profile. On `guided` / `guided-sales`, never suggest `EARVELDAJA_EXPOSE_SETUP_TOOLS`: it switches the profile to `custom` and replaces the guided tool surface.
<!-- E_ARVELDAJA_FEATURE_END:no-credential-tools -->
5. State that the MCP server must be restarted before newly stored or changed credentials become active.
