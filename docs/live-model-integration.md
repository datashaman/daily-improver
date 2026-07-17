# Live structured-provider integration

This opt-in proof drives the MoneyAllocator fixture through both stages of `createTrustedRunnerStructuredProvider` against a real customer-runner structured endpoint. It is deliberately excluded from `npm test` and `npm run checkpoint`.

## Runner contract

The customer runner, not the repository, supplies:

- an absolute path to `trusted-runner-structured-provider-configuration/v1` JSON;
- an absolute path to one `model-endpoint-resolution/v1` JSON value;
- an absolute path to one `model-credential-exchange-resolution/v1` JSON value;
- distinct, short-lived test and build runner identity assertions acquired immediately before invocation;
- an absolute dedicated workspace path that does not yet exist.

The endpoint and exchange resolution files must be regular files no larger than 1 MiB. The configuration, routing, endpoint, and cost examples in the main README show the required provider policy. The endpoint resolution has this shape:

```json
{
  "schemaVersion": "model-endpoint-resolution/v1",
  "endpointId": "customer-private-endpoint",
  "url": "https://models.customer.example/structured-agent",
  "timeoutMs": 30000,
  "maxRequestBytes": 128000,
  "maxResponseBytes": 128000
}
```

The credential exchange resolution has this shape:

```json
{
  "schemaVersion": "model-credential-exchange-resolution/v1",
  "url": "https://control.customer.example/model-credentials",
  "issuer": "https://token.actions.githubusercontent.com",
  "audience": "daily-improver-control-plane",
  "timeoutMs": 30000,
  "maxRequestBytes": 128000,
  "maxResponseBytes": 128000
}
```

The selected opaque endpoint ID must exist in the provider endpoint policy. The credential exchange must return distinct `model-stage-credential/v1` secrets for the exact test/build stage and hashed repository/specification scope, with lifetimes no longer than fifteen minutes.

The structured endpoint must run inside, or be controlled by, the customer runner and be bound out-of-band to the exact `DAILY_IMPROVER_LIVE_WORKSPACE` path. It must materialize only the response-declared files in that workspace. The HTTPS request intentionally contains no host path or repository source, so a remote endpoint without this runner-side workspace binding cannot perform the proof.

## Invocation

Acquire fresh stage identity assertions using the runner's identity mechanism, then invoke:

```bash
export DAILY_IMPROVER_LIVE_MODE=require
export DAILY_IMPROVER_LIVE_CONFIGURATION_PATH=/runner/config/structured-provider.json
export DAILY_IMPROVER_LIVE_ENDPOINT_RESOLUTION_PATH=/runner/config/model-endpoint.json
export DAILY_IMPROVER_LIVE_EXCHANGE_RESOLUTION_PATH=/runner/config/credential-exchange.json
export DAILY_IMPROVER_LIVE_TEST_IDENTITY_ASSERTION='<fresh-test-stage-assertion>'
export DAILY_IMPROVER_LIVE_BUILD_IDENTITY_ASSERTION='<fresh-build-stage-assertion>'
export DAILY_IMPROVER_LIVE_WORKSPACE=/runner/work/daily-improver-money-allocator-live
npm run test:live-model
```

The workspace and the adjacent `-state` path must not already exist. The harness creates both, removes them on completion or failure, and never prints the identity assertions. Do not place assertions, stage credentials, tokens, or permanent API keys in the repository or JSON configuration files.

For a workflow where live inputs are optional, set `DAILY_IMPROVER_LIVE_MODE=skip`. In that mode absent inputs produce an intentional test skip before files or network are accessed. In `require` mode, absent input fails before network access. Omitting the mode is an error so a live-call decision is always explicit.

## Proof gates

The live run must demonstrate all of the following:

1. The test-stage endpoint materializes its declared MoneyAllocator property test, which emits the required `property-test-execution-proof/v1` artifact during execution.
2. The generated test fails against the committed defective baseline.
3. The test/specification artifacts are sealed before the builder runs.
4. The build-stage endpoint changes only its bounded declared implementation files.
5. Fresh verification validates the manifest, allowlists, diff bounds, semantic source checks, and repository test command.
6. Both stage attempt logs finish as `completed`, cost reservations settle, and the publication request remains a draft.
7. Persisted run JSON contains no runner identity assertion or trusted endpoint/exchange locator.
