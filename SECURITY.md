# Security

## Design

- The MCP/HTTP server binds to localhost only (127.0.0.1 / ::1); it is never meant to be exposed to a network.
- Access requires a token (generated per install and stored with user-only permissions); requests without it are rejected.
- File access is confined to configured workspace roots; paths outside them are refused, including via symlinks or `..` segments.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting (the "Report a vulnerability" button under the repository's Security tab). Do not open a public issue for security problems.
