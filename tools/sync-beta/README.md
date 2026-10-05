# LionsLab private beta

Configuration and operation: [private beta guide](../../docs/local-first-sync-private-beta.md).

Build the server from the repository root:

```sh
docker build -f tools/sync-beta/Dockerfile -t lionpocket-beta:YOUR_RELEASE .
```

Keep runtime configuration outside Git. Required `.env` values: `POSTGRES_PASSWORD`, `KEYCLOAK_ADMIN_PASSWORD`, `API_IMAGE`, `TUNNEL_CREDENTIALS`. Use strong URL-safe secrets. Add private beta accounts to the external realm file; the checked-in realm contains no users. Never copy runtime files back into the source archive.

The runtime directory must also include `keycloak-theme/lionpocket/` from this folder. The realm selects that theme so the external OIDC login keeps the same Juba visual language as the app instead of falling back to Keycloak blue.

The compose project has no published host ports. The existing dedicated tunnel routes only the two beta hostnames. See `operate.sh` for backup, isolated restore rehearsal, deploy, restart and image rollback.
