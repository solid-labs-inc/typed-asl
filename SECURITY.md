# Security Policy

## Supported versions

Fixes land on the latest published minor. There are no long-term support
branches; if you are on an older minor, the upgrade path is forward.

## Reporting a vulnerability

Please report privately through GitHub's
[**Report a vulnerability**](https://github.com/solid-labs-inc/typed-asl/security/advisories/new)
flow rather than opening a public issue. We aim to acknowledge within a
week and to credit reporters in the advisory unless you'd rather not be.

## Threat model, honestly

This is a build-time code generator. It takes TypeScript you wrote and
emits an Amazon States Language JSON object. At runtime it opens no
sockets, reads no files, spawns no processes, and evaluates nothing
dynamically — and it ships with **zero runtime dependencies** (`zod` is a
peer dependency you already control). The realistic attack surface is
therefore narrow, and reports in these areas are the most useful:

- **Emitted ASL that does not match the declared types** — a payload
  mapping or `ResultSelector` that sends a field the schema didn't
  sanction, or a ref that resolves somewhere unintended. This is the
  library's core promise, so a break here is a security-relevant bug even
  when it looks like a correctness bug.
- **Injection through state or field names** into the generated JSON —
  values that escape their intended position in the emitted document.
- **Supply-chain integrity** of the published package. Releases are built
  by the tagged GitHub Actions workflow and published through npm trusted
  publishing (OIDC), so every tarball carries provenance traceable to a
  commit in this repository. If a published artifact's provenance does not
  match, that is a report we want immediately.

Out of scope: vulnerabilities in AWS Step Functions itself, in the Lambdas
you point the library at, or in your deployment tooling.

### A note on development dependencies

`npm audit` may report advisories in the development toolchain (bundler,
test runner, and their transitive dependencies). Those packages are not
part of the published artifact — `files` in `package.json` ships `dist`
only. We still track them, but an advisory that is unreachable from
anything a consumer installs will be documented rather than fixed by
force-upgrading a major version.
