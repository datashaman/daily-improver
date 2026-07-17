# ADR 0001: Portable CLI with repository-local execution

Status: accepted

## Decision

Build the product as a portable staged CLI. Deliver it initially through a GitHub App and GitHub Actions, while executing source-aware work only inside customer-controlled workflow jobs.

The canonical stages are `analyse`, `specify`, `test`, `build`, `verify`, and `publish`. Artifacts cross stages; model credentials do not. PR creation belongs to the App identity.

## Consequences

The engine remains usable from GitLab, local schedulers, and customer-hosted deployments. The hosted service can stay small and cannot accidentally become a repository warehouse. Workflow complexity is higher because fresh-checkout verification and artifact integrity are deliberate security boundaries.
