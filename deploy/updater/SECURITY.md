# Updater security model

## Trust boundary

The browser never communicates with the host updater. An authenticated Owner request passes through normal session validation, protected `systemUpdate.*` permissions, recent-authentication step-up, audit logging, and a narrow API client. Community-scoped administrators cannot operate the deployment-wide updater. The API reaches the independent host agent through a mode-restricted Unix socket and signs each short-lived request with a separately provisioned secret. Protocol-v2 signatures bind the protocol, method, exact path, timestamp, random nonce, and request-body digest. Used nonces are retained in a bounded durable replay cache. The API, Web, and Worker containers never receive the Docker socket.

The agent accepts only strict stable semantic versions and idempotency keys. It owns fixed canonical deployment, state, backup, Compose, and environment paths. Image repositories, service names, command executables, and argument structures are compiled into the agent. No request can provide a command, shell, image repository, Compose path, environment path, or filesystem path.

## Mitigations

- Member and community Admin accounts cannot access the updater. Owner execution requires the existing five-minute passkey/password step-up.
- Same-site session cookies and the existing request model limit CSRF. Signed requests expire after 30 seconds, and a cryptographically random nonce is accepted only once by the bounded durable replay cache.
- Target versions use strict semver. Release contract version `2` requires a matching annotated tag and source commit, an exact manifest and four-bundle evidence set, the official three GHCR repositories, immutable SHA-256 digests, and GitHub provenance policy. Missing, unsupported, or digest-only legacy contracts require manual installation or fail closed.
- The agent verifies bounded raw manifest bytes against the release's local JSONL bundle with packaged `<updater-root>/bin/gh attestation verify --bundle` before parsing deployment fields. Repository, workflow, OIDC issuer, SLSA predicate, tag ref, and independently resolved source commit are compiled policy. Tampering, missing evidence, invalid identity, trusted-root failure, timeout, or unsupported contracts fail closed.
- Each API, Web, and Worker digest is verified against its own bounded local JSONL bundle. The verifier receives a fresh empty GitHub and Docker configuration and no user token; OCI subject notation identifies the exact repository and digest but does not supply attestation evidence or require registry authentication. A pulled `RepoDigest` remains a separate execution-time check before migration and deployment.
- The host lock is authoritative. Startup treats a lock left by the prior agent as an interrupted run and applies a phase-specific recovery decision; migration and deployment ambiguity fail to `MANUAL_INTERVENTION_REQUIRED` rather than replaying side effects.
- Commands use fixed executable and argv arrays. Output is normalized, length-bounded, and centrally redacted before persistence or display.
- Canonical non-symlink directories, non-world-writable socket parents, exclusive lock creation, and fixed child paths limit traversal and symlink replacement.
- Backups complete and pass `pg_restore --list` before image pull or migration. Images are pulled before service recreation.
- Application rollback occurs only when the release explicitly declares database compatibility. Database dumps are never restored automatically.
- API restart and browser refresh do not own execution state. The host keeps atomic run JSON plus sequenced JSONL events; the browser resumes by sequence through Socket.IO with REST polling fallback.
- Request bodies, release responses, release notes, nonce history, command output, API history, checks, and host run files are bounded or retained under explicit limits.

## Security invariants

1. The API never gains Docker socket access.
2. The browser never communicates directly with the updater agent.
3. The updater never executes user-supplied commands.
4. Mutable image tags are never sufficient proof of identity.
5. Neither a release asset nor a manifest digest is trusted without valid manifest provenance.
6. A manifest provenance failure never reaches image pull; an image provenance failure never reaches migration or deployment.
7. No Owner or UI override can bypass provenance policy.
8. Historical tags are not automatically trusted as releases.
9. Release metadata cannot redefine updater trust roots or identities.
10. Database rollback is never performed automatically.

## Residual risks

A compromised stepped-up Owner session can authorize a valid official release. Possession of the socket alone is insufficient without a valid HMAC secret, but compromise of both is equivalent to control-plane authorization. Residual trust includes GitHub, repository owners and protected-tag settings, the SHA-pinned release workflow, GHCR for later image pulls, GitHub/Sigstore trust roots, the supported host GitHub CLI package, host root, and the updater IPC secret. Evidence and trusted-root retrieval require outbound HTTPS but no end-user credentials. Air-gapped trust-root lifecycle support remains deferred. The design supports one deployment host and rejects incompatible protocol or topology before installation. Database rollback remains an operator-led recovery action.

## Release trust chain

`annotated protected tag → SHA-pinned GitHub Actions workflow → immutable GHCR digests → image attestations → final manifest → manifest attestation → validated draft release assets → published release → agent verification → installation`

The permanent `v0.0.0` public fixture exercises this same cryptographic chain for maintainer validation. It is published non-latest, cannot be installed or discovered as a normal update, and may only be targeted by the credentialless `verify-release` command. Its repository, signer workflow, OIDC issuer, annotated tag ref, source commit, release contract, evidence inventory, and digest checks are identical to production policy.

Build jobs cannot write releases. Only the final publication job receives `contents: write`; attestation permissions are limited to jobs that generate attestations. The release remains draft until exact asset names, sizes, and GitHub SHA-256 digests match local artifacts. Published releases are never overwritten by workflow reruns, and `--clobber` is prohibited. GitHub immutable releases and restricted creation/deletion of matching release tags are required repository-side production controls.
