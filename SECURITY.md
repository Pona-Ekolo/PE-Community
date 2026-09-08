# Security Policy

## Supported Versions

Security fixes are provided for the latest published release. There is no public release yet; this policy becomes active with the first tagged release.

## Reporting a Vulnerability

Do not report vulnerabilities through public issues, discussions, pull requests, screenshots, or logs.

Once this repository is published, report vulnerabilities through GitHub Private Vulnerability Reporting. Do not open a public issue. The repository owner must enable that feature before accepting public security reports; this policy does not claim that it is enabled before publication.

Include a concise description, affected version, reproduction steps, impact, and suggested mitigation when available. Do not include unrelated personal data or real production secrets.

## Response Expectations

After the reporting channel is configured, maintainers should acknowledge reports privately, reproduce and assess them, coordinate a fix and disclosure timeline, and credit reporters when requested and appropriate.

## Tracked Dependency Exception

`GHSA-ggr8-5vv4-36mx` reports a high-severity stack-exhaustion issue in
`deepmerge-ts` versions below 8.0.0. PE Community currently resolves
`deepmerge-ts@7.1.5` only through the exact dependency chain
`@prisma/client@6.19.3` -> `prisma@6.19.3` -> `@prisma/config@6.19.3`.
Prisma 6.19.3 is the latest supported Prisma 6 release and its configuration
package pins that version exactly. Forcing `deepmerge-ts` 8 would violate that
upstream contract, so no transitive override is used.

The affected merge operation is Prisma configuration handling. PE Community
does not pass remote request data into Prisma configuration; the package is
used by controlled build, migration, and local tooling inputs. The API image
intentionally includes Prisma CLI to run migrations during deployment, and the
worker currently copies the shared root dependency tree. The advisory therefore
remains visible in `pnpm audit`, but is not remotely reachable through current
application request paths.

This exception must be removed when a compatible Prisma 6 release (or a
separately planned, validated Prisma major upgrade) resolves
`GHSA-ggr8-5vv4-36mx` without an unsupported transitive override.
