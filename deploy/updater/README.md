# Host updater bootstrap

The updater is an independent host service. The API receives access only to its Unix socket; no application container receives the Docker socket.

## Existing installations before the updater

PE Community v1.2.3 includes the API-side updater integration. An installation running v1.1.1 or another pre-updater version needs one final manual application upgrade before it can use the host updater. The first published portable-updater release can then bootstrap the host service while the application remains on v1.2.3. Automatic updates become available after that bootstrap and the System Updates status check succeed.

## Install once

From the PE Community project directory, run:

```bash
sudo ./deploy/updater/install.sh
```

The installer detects the project, selects the host architecture, finds the newest published stable release with the complete portable updater contract, verifies the matching official release asset digest, installs the package at `<project-root>/.pe/updater`, configures the authenticated API-only socket override, writes the systemd environment, starts the service, and recreates only the API. It does not update the application or change `PE_COMMUNITY_VERSION`.

Use an explicit stable release when needed:

```bash
sudo ./deploy/updater/install.sh --project-dir /path/to/pe-community --version vX.Y.Z
```

`--version` selects the updater package release only. It does not select or install a new PE Community application version.

The package carries its pinned `gh` verifier at `<updater-root>/bin/gh`. Runtime resolution is relative to the installed package; the updater never uses a host `gh` from `PATH`.

## Public release verification

An ordinary local operator can verify a future contract-version-2 release without `sudo`, Docker access, systemd access, the updater socket, or the updater shared secret:

```bash
.pe/updater/bin/pe-community-updater verify-release vX.Y.Z
```

The command uses the root-owned, non-writable bundled `gh` executable from the installed updater package. Public release verification requires no GitHub account, GitHub token, `gh auth login`, or GHCR/Docker login. It downloads the release's GitHub/Sigstore JSONL evidence bundles and verifies the manifest plus immutable API, Web, and Worker image identities against the fixed PE Community repository, workflow, OIDC issuer, release tag, and source commit policy. `--json` emits only the authenticated release metadata and image digests. An explicit plan file is available for the later Compose deployment step:

```bash
.pe/updater/bin/pe-community-updater verify-release vX.Y.Z \
  --output-plan /tmp/pe-community-vX.Y.Z-images.compose.yml
```

The generated plan contains only digest-pinned `repository@sha256:...` image references. It does not pull images, contact the updater socket, modify application files, run migrations, create backups, or start services. The later cutover commands may require the host privileges appropriate to the installation's Docker model.

`v1.2.9` uses the earlier contract-version-1 evidence set and is not eligible for new automatic verification. It remains manual-only; the release and tag must not be changed to retrofit the newer contract.

## First portable updater release notes

Portable updater bootstrap is available for Linux amd64 and arm64. Existing installations can install the host updater without changing their current PE Community application version. After bootstrap, an Owner uses **Settings → System Updates** to check and approve later application updates. The API is the only application component that can reach the updater over authenticated Unix IPC; application containers do not receive the Docker socket. Each updater archive includes the bundled GitHub CLI verifier and required operator/support files.

## Verify the bootstrap

Run these commands on the deployment host before enabling UI installation:

```bash
systemctl is-active pe-community-updater
systemctl show pe-community-updater -p User -p Group -p NoNewPrivileges -p ProtectSystem
<project-root>/.pe/updater/bin/gh version
stat -c '%U %G %a %F' /run/pe-community-updater /run/pe-community-updater/updater.sock
docker compose --env-file .env -f docker-compose.prod.yml -f .pe/updater/docker-compose.updater.yml ps
docker compose --env-file .env -f docker-compose.prod.yml -f .pe/updater/docker-compose.updater.yml exec -T api test -S /run/pe-community-updater/updater.sock
```

The directory must not be world-writable, the socket must report mode `660`, and only API receives the read-only runtime-directory mount. The status response must report agent `1.4.0`, protocol `2`, and topology `single-host`. Validate Settings → System Updates status before attempting an installation.

## Repair or uninstall

Re-run the command to repair or replace the local updater package safely:

```bash
sudo ./deploy/updater/install.sh --repair
```

To remove updater host integration without touching application data, database data, uploads, Redis data, or application images:

```bash
sudo ./deploy/updater/install.sh --uninstall
```

## Maintainer supply-chain validation

`v0.0.0` is permanently reserved as the public updater supply-chain validation fixture. It is not an application release, is explicitly published with `make_latest=false`, cannot be installed, and cannot be returned by normal latest-release discovery. Maintainers may use `verify-release v0.0.0` to exercise the production verifier against genuine public Sigstore evidence. The fixture uses the same annotated-tag, repository, signer workflow, OIDC issuer, source-ref, source-commit, digest, contract-version-2, and exact seven-asset requirements as a production release. Its image tags are commit-bound validation identities and are never `latest` or stable production tags.

Before the first production updater bootstrap, an authorized maintainer can run **Release and supply-chain validation** manually from `main`. The dispatch requires an existing published, stable, annotated release tag as a production-provenance test subject. That tag is not the validation build source: the workflow checks out the current dispatch SHA from `main`, builds and attests current API, Web, and Worker validation images under unique `validation-<run-id>` tags, and packages both current updater architectures. Validation image metadata uses the explicit non-release version `v0.0.0-validation.<run-id>`; it is never an installable stable release.

The workflow extracts `gh` from the generated amd64 updater archive and performs two separate checks. First, a CI-only policy verifies the current validation image bundles against the current `main` source identity. Second, the same bundled verifier downloads the selected release's manifest and four JSONL attestation bundles, verifies the manifest before reading image digests, and verifies all three historical image bundles using the production tag-bound policy. The historical proof requires release contract version `2`; older releases remain manual-only.

Validation mode does not create a tag, GitHub Release, or deployment, and normal update discovery ignores it because discovery uses published GitHub Releases rather than GHCR tags or workflow artifacts. Validation tags may remain in GHCR temporarily; remove only the explicitly named validation tags through normal package administration. Stable tag pushes retain the release publication path. The CI-only `main` assertion is not available to the runtime updater, which continues to require the fixed production tag-bound provenance policy.

The service intentionally runs with host Docker access, a strict image allowlist, and no remote listener. The installer writes the selected project, package, backup, state, and runtime paths into its environment; `ProtectSystem=strict` is paired with those explicit writable paths. Network address families remain available because release discovery and registry pulls require them.

## Automatic release contract

Automatic installation requires release contract version `2`: a published, non-draft, non-prerelease GitHub Release created from an annotated strict-semver tag on `main`; an exact seven-asset inventory containing the manifest, four JSONL attestation bundles, and two updater archives; a strict schema-v2 manifest whose `version` and `releaseTag` match; a 40-character `sourceCommit` matching the tag target; official API/Web/Worker GHCR repositories with immutable digests; and valid GitHub build provenance for the exact manifest bytes and all three image digest subjects. Unsupported or historical contracts fail closed or require manual handling.

The updater downloads the manifest under a 128 KiB bound and each bundle under a 4 MiB bound, independently resolves the annotated release tag, writes untrusted evidence to mode-0600 files in a private temporary directory, and invokes the bundled official `gh attestation verify --bundle` before trusting manifest fields or image identities. The pinned verifier validates GitHub/Sigstore certificates and transparency evidence using its supported public trust-root retrieval; release assets cannot supply or redefine a trust root. Verification fixes repository `Pona-Ekolo/PE-Community`, signer workflow `.github/workflows/publish-images.yml`, OIDC issuer, SLSA provenance v1, release tag ref, source commit, service repository, and digest.

Digest-only manifests and historical tags without the complete release contract require manual operator handling. A missing or malformed bundle, unsupported verifier, signature/identity/workflow/digest/commit mismatch, trusted-root failure, GitHub API rate limit, or network failure blocks verification. There is no UI or environment override. The verifier runs with a fresh empty home, GitHub config, and Docker config and receives no user GitHub credentials. Release discovery and evidence retrieval remain online and anonymous; trusted-root retrieval uses the verifier's public Sigstore/TUF mechanism. Air-gapped verification is not provided by this phase.

The release workflow pins every action dependency to a reviewed full commit SHA. It downloads the exact official GitHub CLI 2.93.0 archive separately for Linux amd64 and arm64, verifies the upstream SHA-256 and expected archive layout, and includes the upstream MIT notice in each updater archive. GitHub-hosted validation natively executes and version-checks only the amd64 verifier. The arm64 archive is checksum-, executable-, architecture-, and bundle-contract-validated without emulation; native arm64 execution is not claimed by CI. A runtime arm64 updater host continues to perform its normal native verifier checks. The workflow builds and attests images before creating any release, generates the final manifest and updater packages in the publication job, attests the exact manifest file, then creates or resumes only an empty draft. It uploads the manifest, its JSONL bundle, the API/Web/Worker JSONL bundles, and both architecture-specific updater packages without overwrite; verifies the exact asset-name, size, and GitHub-reported SHA-256 inventory; and publishes once. A partial draft remains invisible for operator inspection and must be cleaned up deliberately before retry. A published release or non-empty draft causes a safe abort. Enable GitHub immutable releases and protected `v*.*.*` release tags in repository settings before the first updater-aware release; the workflow does not change those settings.

Kernel, control-group, clock, hostname, realtime, setuid/setgid, executable-memory, and home-directory restrictions are enabled. `PrivateNetwork` is intentionally omitted because GitHub/GHCR and health checks require networking. `CapabilityBoundingSet` and `PrivateUsers` are intentionally omitted because Docker socket access and existing root-owned deployment files must be validated across supported self-hosted distributions. The agent remains effectively host-privileged and must be treated accordingly.

## Rotate the IPC secret

1. Generate a new independent high-entropy secret.
2. Configure the host agent with the new value as `PE_UPDATER_SHARED_SECRET` and the old value as `PE_UPDATER_SHARED_SECRET_PREVIOUS`, then restart the agent.
3. Update the application `.env` to the new current secret and recreate API only.
4. Confirm updater status, remove `PE_UPDATER_SHARED_SECRET_PREVIOUS`, and restart the agent again.

Never place either secret in command arguments or logs. The previous-secret setting is a temporary overlap mechanism, not permanent configuration.

## Upgrade or disable

Stop the service before replacing the updater files, verify the release artifact, replace the directory atomically, and start it again. If a target manifest requires a newer updater, the application reports `MANUAL_REQUIRED` and does not install the release.

To disable automatic updates, run the supported uninstall command and retain the project-local updater state and latest backup until the deployment is verified.

To roll back the bootstrap itself, disable the service, restore the pre-bootstrap Compose file and `.env`, recreate API only, and verify normal application health. This removes updater access without changing PostgreSQL, Redis, Web, Worker, uploads, or application data.

Do not delete an active run lock or restore a database dump automatically. A run interrupted after migration requires an operator to inspect compatibility and the retained backup first.
