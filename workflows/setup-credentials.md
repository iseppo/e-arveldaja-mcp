# Setup e-arveldaja Credentials

Inspect the current credential setup, import credentials from an `apikey*.txt` file when available, and explain the required restart and next steps.

## Arguments

- Optional `file_path`: absolute path to an `apikey*.txt` file to import
- Optional `storage_scope`: `local` or `global`

## Step 1: Inspect the current setup state

Call `get_setup_instructions` first.

Treat its response as the source of truth for:
- whether the server is currently in `setup` or `configured` mode
- `working_directory`
- `searched_directories`
- `global_config_directory`
- `global_env_file`
- the supported credential file env var and filename pattern

## Step 2: Explain the current status

- If `mode="setup"`, say clearly that API-backed workflows are blocked until credentials are configured.
- If `mode="configured"`, say clearly that credentials already exist and this workflow can be used to inspect, append, replace, or remove stored `.env` credentials.

<!-- E_ARVELDAJA_FEATURE_START:no-credential-tools -->
The credential-management tools (import, list, and remove stored credentials) are not registered on this server's current tool surface: they appear in `setup` mode on the `standard`/`full` profiles, or when the server is started with `EARVELDAJA_EXPOSE_SETUP_TOOLS=1`. Explain the setup paths from `get_setup_instructions` (environment variables, a `.env` file in the local or global config directory, or `EARVELDAJA_API_KEY_FILE`). On `EARVELDAJA_PROFILE=guided` / `guided-sales`, add the credentials through the environment variables or a local or shared `.env` file (no profile change needed), or — to import an `apikey*.txt` file from a tool call — start the server temporarily with `EARVELDAJA_PROFILE=full` (it includes the credential tools) and switch back to the guided profile afterwards. Do NOT suggest `EARVELDAJA_EXPOSE_SETUP_TOOLS=1` there: setting any legacy exposure flag switches the profile to `custom` and replaces the guided tool surface. On the `standard` profile, restarting with `EARVELDAJA_EXPOSE_SETUP_TOOLS=1` adds the import tool (the profile then normalizes to `custom`: the standard tool set plus the credential tools), as does `EARVELDAJA_PROFILE=full`. Follow the `next_steps` from `get_setup_instructions`, which already names the right path for the running profile. Skip Steps 3–6.
<!-- E_ARVELDAJA_FEATURE_END:no-credential-tools -->

Explain the two storage scopes:
- `local`: works only when the MCP server is started from this folder
- `global`: works when the MCP server is started from any folder on this computer

<!-- E_ARVELDAJA_FEATURE_START:credential-tools -->
## Step 3: Import credentials (preview first, then execute)

`import_apikey_credentials` is preview-first. It never writes on the first call:
the default call verifies the credential and PROJECTS where it would be stored,
then returns a `plan_handle`. You persist by calling the tool a second time with
`execute: true` and that exact `plan_handle`. The handle is single-use and is
rejected if the source file or destination `.env` changed since the preview, so
always call the preview immediately before the execute.

### Preview

Call `import_apikey_credentials` to preview:
- `file_path`: the provided path, if any. Omit it to use the only secure `apikey*.txt` in the working directory.
- `storage_scope`: the provided scope when present; otherwise omit it so the client can choose interactively when supported.

Handle the preview outcomes:
- If exactly one secure `apikey*.txt` is available and it verifies, the tool returns a projection plus a `plan_handle`.
- If `action` is `unchanged`, the exact credential is already stored — report that and stop; no `plan_handle` is issued and nothing needs to be persisted.
- If the tool reports multiple candidate files, stop and ask the user which file should be imported.
- If the tool reports no secure apikey file, explain the setup paths from `get_setup_instructions` and stop.

By default, different credentials are projected as an additional stored connection when a default connection already exists. Set `overwrite: true` only if the user explicitly approves replacing the default stored connection — pass it on BOTH the preview and the execute so the projection matches.

### Review and execute

Show the user the previewed `company_name`, `env_file`, `storage_scope`, and `target`. After they approve, call `import_apikey_credentials` again with:
- the same `file_path` / `storage_scope` / `overwrite`
- `execute: true`
- `plan_handle`: the handle from the preview (the preview's `suggested_execute_args` already contains these)

If the execute is rejected with a `plan_drift`, `plan_handle_consumed`, or `plan_handle_expired` error, re-run the preview to get a fresh handle and try again — do not retry with the old handle.

## Step 4: Handle stored-credential removal explicitly

If the user wants to remove stored credentials instead of importing:
- call `list_stored_credentials`
- explain that it only shows credentials stored in local/global `.env` files, not shell env vars, `EARVELDAJA_API_KEY_FILE`, or raw `apikey*.txt` files
- `remove_stored_credentials` is preview-first, exactly like import. Call it with `storage_scope` and `target` to PREVIEW the removal — it writes nothing and returns a `plan_handle`. Show the user which `target` would be removed and how many blocks remain.
- if the user confirms, call `remove_stored_credentials` again with the same `storage_scope` and `target`, plus `execute: true` and the `plan_handle` from the preview.
- if the execute is rejected with a `plan_drift`/`plan_handle_consumed`/`plan_handle_expired` error, re-run the preview for a fresh handle rather than reusing the old one.
- state clearly that removal is destructive and requires a restart

## Step 5: Handle clients without interactive prompting

If `import_apikey_credentials` reports that the client does not support interactive setup prompting:
- explain that `storage_scope` must be provided explicitly
- ask the user to choose `local` or `global`
- retry with the chosen `storage_scope`

## Step 6: Report a successful import

If import succeeds, report:
- `env_file`
- `storage_scope`
- `company_name`
- `verified_at`
- `source_file`
<!-- E_ARVELDAJA_FEATURE_END:credential-tools -->

## Step 7: Restart requirement

State clearly:
- the MCP server must be restarted before the stored credentials become active
- the newly imported credentials are not yet active in the current server process

## Step 8: First verification after restart

After restart, recommend:
- call `list_connections`
- if at least one connection is present, continue with the desired workflow
