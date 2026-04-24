# Setup e-arveldaja

Explain how to configure e-arveldaja MCP credentials for the current working directory.

Follow these steps:

1. Call `get_setup_instructions`.
2. Report whether the server is in `setup` or `configured` mode.
3. Explain the supported credential paths:
   - `EARVELDAJA_API_KEY_ID`
   - `EARVELDAJA_API_PUBLIC_VALUE`
   - `EARVELDAJA_API_PASSWORD`
   - `EARVELDAJA_API_KEY_FILE`
   - importing a secure `apikey*.txt` with `import_apikey_credentials`
4. If credentials need importing, use `import_apikey_credentials` only after the user identifies the file or confirms the detected single candidate.
5. After a successful import, state that the MCP server must be restarted before the stored credentials become active.
