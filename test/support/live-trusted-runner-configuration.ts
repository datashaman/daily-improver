import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  trustedRunnerIdentitySchemaVersion,
  type TrustedRunnerIdentitySource,
} from "../../src/agents/trusted-runner-model-stage-credential-source.js";

export const liveRunnerEnvironment = {
  mode: "DAILY_IMPROVER_LIVE_MODE",
  configurationPath: "DAILY_IMPROVER_LIVE_CONFIGURATION_PATH",
  endpointResolutionPath: "DAILY_IMPROVER_LIVE_ENDPOINT_RESOLUTION_PATH",
  exchangeResolutionPath: "DAILY_IMPROVER_LIVE_EXCHANGE_RESOLUTION_PATH",
  testIdentityAssertion: "DAILY_IMPROVER_LIVE_TEST_IDENTITY_ASSERTION",
  buildIdentityAssertion: "DAILY_IMPROVER_LIVE_BUILD_IDENTITY_ASSERTION",
  workspace: "DAILY_IMPROVER_LIVE_WORKSPACE",
} as const;

const maximumRunnerOwnedJsonBytes = 1_048_576;
const maximumAssertionBytes = 16_384;

export interface LiveTrustedRunnerConfiguration {
  readonly configuration: unknown;
  readonly endpointResolution: unknown;
  readonly exchangeResolution: unknown;
  readonly identitySource: TrustedRunnerIdentitySource;
  readonly workspace: string;
  readonly sensitiveValues: readonly string[];
}

export type LiveTrustedRunnerInvocation =
  | { readonly status: "skip"; readonly reason: string }
  | { readonly status: "ready"; readonly value: LiveTrustedRunnerConfiguration };

export async function loadLiveTrustedRunnerInvocation(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<LiveTrustedRunnerInvocation> {
  const mode = environment[liveRunnerEnvironment.mode];
  if (mode !== "skip" && mode !== "require") {
    throw new Error(`${liveRunnerEnvironment.mode} must explicitly equal skip or require.`);
  }
  const missing = requiredNames().filter((name) => !environment[name]);
  if (missing.length > 0) {
    if (mode === "skip") {
      return { status: "skip", reason: `Live runner configuration is absent: ${missing.join(", ")}.` };
    }
    throw new Error(`Live runner configuration is required before network access: ${missing.join(", ")}.`);
  }

  const configurationPath = required(environment, liveRunnerEnvironment.configurationPath);
  const endpointResolutionPath = required(environment, liveRunnerEnvironment.endpointResolutionPath);
  const exchangeResolutionPath = required(environment, liveRunnerEnvironment.exchangeResolutionPath);
  const workspace = requiredAbsolutePath(environment, liveRunnerEnvironment.workspace);
  const testAssertion = boundedAssertion(environment, liveRunnerEnvironment.testIdentityAssertion);
  const buildAssertion = boundedAssertion(environment, liveRunnerEnvironment.buildIdentityAssertion);
  if (testAssertion === buildAssertion) {
    throw new Error("Live test and build runner identity assertions must be distinct.");
  }

  const [configuration, endpointResolution, exchangeResolution] = await Promise.all([
    readRunnerOwnedJson(configurationPath),
    readRunnerOwnedJson(endpointResolutionPath),
    readRunnerOwnedJson(exchangeResolutionPath),
  ]);
  const sensitiveValues = [
    testAssertion,
    buildAssertion,
    ...jsonLocatorValues(endpointResolution),
    ...jsonLocatorValues(exchangeResolution),
  ];
  return {
    status: "ready",
    value: {
      configuration,
      endpointResolution,
      exchangeResolution,
      workspace,
      sensitiveValues,
      identitySource: {
        async acquire(request) {
          const nowMs = Date.now();
          return {
            schemaVersion: trustedRunnerIdentitySchemaVersion,
            issuer: request.issuer,
            audience: request.audience,
            stage: request.stage,
            scope: request.scope,
            issuedAtMs: nowMs - 1_000,
            expiresAtMs: nowMs + 5 * 60_000,
            assertion: request.stage === "test" ? testAssertion : buildAssertion,
          };
        },
      },
    },
  };
}

export async function assertWorkspaceCanBeCreated(workspace: string): Promise<void> {
  const resolved = resolve(workspace);
  if (resolved === "/" || resolved === resolve(process.cwd())) {
    throw new Error("The live workspace must be a dedicated absent path outside the repository root.");
  }
  try {
    await lstat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("The live workspace must not exist; the integration harness creates and removes it.");
}

function requiredNames(): readonly string[] {
  return [
    liveRunnerEnvironment.configurationPath,
    liveRunnerEnvironment.endpointResolutionPath,
    liveRunnerEnvironment.exchangeResolutionPath,
    liveRunnerEnvironment.testIdentityAssertion,
    liveRunnerEnvironment.buildIdentityAssertion,
    liveRunnerEnvironment.workspace,
  ];
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredAbsolutePath(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(environment, name);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute runner-owned path.`);
  return resolve(value);
}

function boundedAssertion(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(environment, name);
  const size = Buffer.byteLength(value, "utf8");
  if (size < 1 || size > maximumAssertionBytes) throw new Error(`${name} is outside its supported bounds.`);
  return value;
}

async function readRunnerOwnedJson(path: string): Promise<unknown> {
  if (!isAbsolute(path)) throw new Error("Live configuration files must use absolute runner-owned paths.");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > maximumRunnerOwnedJsonBytes) {
    throw new Error("A live runner configuration file is not a bounded regular file.");
  }
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function jsonLocatorValues(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const url = (value as Record<string, unknown>).url;
  return typeof url === "string" ? [url] : [];
}
