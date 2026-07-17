# OpenAI local model proof

This is the simplest real-model route for the MoneyAllocator fixture. It calls the OpenAI Responses API directly from an isolated local worktree, while the ordinary CLI and deterministic checkpoint suite remain unchanged.

## Safety boundary

The provider:

- reads at most 16 regular allowlisted source/test-harness files, 64 KiB each and 256 KiB total;
- excludes protected generated-test inputs from builder source context and ignores allowlisted directories rather than treating them as source files;
- never serializes the host checkout path or API key;
- treats repository content as untrusted prompt data;
- requests a strict JSON Schema response through `text.format`;
- validates response collections, paths, allowlists, protected paths, content sizes, and specification file limits before writing;
- writes complete replacement files through same-directory temporary files;
- caps the maximum estimated request cost before transport and validates estimated usage afterward;
- stores only bounded usage and model rationale through the established independent manifest, diff, source-safety, and verification gates;
- retains only an HTTP status and bounded machine error code from failed API responses.

The runner also supplies bounded trusted requirements for the detected execution harness. For the MoneyAllocator fixture these require standalone top-level PHP checks because `tests/run.php` directly loads generated files. A nonzero baseline is not sufficient evidence by itself: known syntax, resource-limit, dependency, and autoload failures are rejected before the builder runs.

The default is `gpt-5.6-terra` with medium reasoning, 4,000 maximum output tokens, and the documented July 2026 estimate of `$2.50` per million input tokens and `$15` per million output tokens. The official model guide currently recommends Terra as the GPT-5.6 balance of intelligence and cost. Pricing and availability can change; update and verify these runner-owned proof settings before relying on cost estimates.

References: [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), and [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create).

## Invocation

The ignored local key file contains:

```dotenv
OPENAI_API_KEY=<project-api-key>
```

Never commit or print that value. Run:

```bash
npm run test:openai-live
```

To select another accessible model:

```bash
DAILY_IMPROVER_OPENAI_MODEL=gpt-5.4-mini npm run test:openai-live
```

Changing the model does not currently change the runner's price estimate, so update the proof configuration in `test/openai-money-allocator.live.ts` before treating its recorded cost as accurate.

The proof passes only when the real model creates a defect test that fails against the committed baseline for a credible behavioral reason, makes a bounded implementation change without touching sealed artifacts, passes fresh verification, and produces a draft publication request. This complete path passed with `gpt-5.6-terra` on 2026-07-17. The API key must belong to a project with available API credit and sufficient model access. ChatGPT subscriptions and API billing are separate.
