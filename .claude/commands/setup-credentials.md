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

Explain the two storage scopes:
- `local`: works only when the MCP server is started from this folder
- `global`: works when the MCP server is started from any folder on this computer

## Step 3: Import credentials

### If `file_path` was provided

Call `import_apikey_credentials` with:
- `file_path`: the provided path
- `storage_scope`: the provided scope when present; otherwise omit it so the client can choose interactively when supported

By default, different credentials are appended as an additional stored connection when a default connection already exists.

Set `overwrite: true` only if the user explicitly approves replacing the default stored connection.

### If `file_path` was not provided

Call `import_apikey_credentials` without `file_path`.
- Include `storage_scope` if it was provided.
- Otherwise omit `storage_scope` so the client can choose interactively when supported.

Handle the outcomes:
- If exactly one secure `apikey*.txt` is available in the working directory, the import should proceed.
- If the tool reports multiple candidate files, stop and ask the user which file should be imported.
- If the tool reports no secure apikey file, explain the setup paths from `get_setup_instructions` and stop.

## Step 4: Handle stored-credential removal explicitly

If the user wants to remove stored credentials instead of importing:
- call `list_stored_credentials`
- explain that it only shows credentials stored in local/global `.env` files, not shell env vars, `EARVELDAJA_API_KEY_FILE`, or raw `apikey*.txt` files
- if the user confirms a specific stored target should be removed, call `remove_stored_credentials` with:
  - `storage_scope`
  - `target`
- state clearly that removal is destructive and requires restart

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

## Step 7: Restart requirement

State clearly:
- the MCP server must be restarted before the stored credentials become active
- the newly imported credentials are not yet active in the current server process

## Step 8: First verification after restart

After restart, recommend:
- call `list_connections`
- if at least one connection is present, continue with the desired workflow
