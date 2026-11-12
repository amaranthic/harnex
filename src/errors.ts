/**
 * @fileoverview Custom error classes for Hernex runtime, model routing, and storage.
 * @packageDocumentation
 */

import { AISDKError } from "ai";

const invalidModelStringErrorName = "HernexInvalidModelStringError";
const invalidModelStringMarker = `hernex.error.${invalidModelStringErrorName}`;
const invalidModelStringSymbol = Symbol.for(invalidModelStringMarker);

/**
 * Error thrown when a model string does not conform to the expected format.
 *
 * Expected format is `provider/modelId` where `provider` is non-empty and
 * `modelId` is non-empty (e.g. `openai/gpt-4o` or `openrouter/openrouter/free`).
 */
export class HernexInvalidModelStringError extends AISDKError {
  /**
   * Internal brand symbol confirming instance identity across package boundaries.
   */
  readonly [invalidModelStringSymbol] = true;

  /**
   * The raw model string that failed validation.
   */
  readonly modelString: string;

  /**
   * Creates an instance of HernexInvalidModelStringError.
   *
   * @param params - Configuration parameters for the error.
   * @param params.modelString - The raw invalid model string provided by the caller.
   * @param params.reason - Detailed explanation of why the model string is invalid.
   */
  constructor({
    modelString,
    reason,
  }: {
    modelString: string;
    reason: string;
  }) {
    super({
      name: invalidModelStringErrorName,
      message: `Invalid model string "${modelString}": ${reason}. Expected format is "provider/model_id" (e.g. "openai/gpt-4o" or "compatible/my-model").`,
    });

    this.modelString = modelString;
  }

  /**
   * Type guard to check whether an unknown error is an instance of HernexInvalidModelStringError.
   *
   * @param error - The value to check.
   * @returns True if the error is an HernexInvalidModelStringError, false otherwise.
   */
  static override isInstance(
    error: unknown,
  ): error is HernexInvalidModelStringError {
    return AISDKError.hasMarker(error, invalidModelStringMarker);
  }
}

const missingCredentialsErrorName = "HernexMissingCredentialsError";
const missingCredentialsMarker = `hernex.error.${missingCredentialsErrorName}`;
const missingCredentialsSymbol = Symbol.for(missingCredentialsMarker);

/**
 * Error thrown when mandatory credentials (`apiKey` or `baseUrl`) are missing from a Hernex request.
 */
export class HernexMissingCredentialsError extends AISDKError {
  /**
   * Internal brand symbol confirming instance identity across package boundaries.
   */
  readonly [missingCredentialsSymbol] = true;

  /**
   * The name of the missing credential parameter (`apiKey` or `baseUrl`).
   */
  readonly missingField: "apiKey" | "baseUrl";

  /**
   * The provider targeted by the request.
   */
  readonly provider: string;

  /**
   * Creates an instance of HernexMissingCredentialsError.
   *
   * @param params - Configuration parameters for the error.
   * @param params.missingField - The specific field that was omitted or empty.
   * @param params.provider - The provider identifier.
   */
  constructor({
    missingField,
    provider,
  }: {
    missingField: "apiKey" | "baseUrl";
    provider: string;
  }) {
    super({
      name: missingCredentialsErrorName,
      message: `Missing required credential "${missingField}" for provider "${provider}". Every Hernex request must supply both non-empty "apiKey" and "baseUrl".`,
    });

    this.missingField = missingField;
    this.provider = provider;
  }

  /**
   * Type guard to check whether an unknown error is an instance of HernexMissingCredentialsError.
   *
   * @param error - The value to check.
   * @returns True if the error is an HernexMissingCredentialsError, false otherwise.
   */
  static override isInstance(
    error: unknown,
  ): error is HernexMissingCredentialsError {
    return AISDKError.hasMarker(error, missingCredentialsMarker);
  }
}

const unsupportedProviderErrorName = "HernexUnsupportedProviderError";
const unsupportedProviderMarker = `hernex.error.${unsupportedProviderErrorName}`;
const unsupportedProviderSymbol = Symbol.for(unsupportedProviderMarker);

/**
 * Error thrown when a requested provider is not supported by the runtime or registry.
 */
export class HernexUnsupportedProviderError extends AISDKError {
  /**
   * Internal brand symbol confirming instance identity across package boundaries.
   */
  readonly [unsupportedProviderSymbol] = true;

  /**
   * The unsupported provider identifier.
   */
  readonly provider: string;

  /**
   * List of provider identifiers currently supported.
   */
  readonly supportedProviders: readonly string[];

  /**
   * Creates an instance of HernexUnsupportedProviderError.
   *
   * @param params - Configuration parameters for the error.
   * @param params.provider - The unsupported provider name.
   * @param params.supportedProviders - Array of supported provider names.
   */
  constructor({
    provider,
    supportedProviders,
  }: {
    provider: string;
    supportedProviders: readonly string[];
  }) {
    super({
      name: unsupportedProviderErrorName,
      message: `Unsupported provider "${provider}". Supported providers are: ${supportedProviders.join(", ")}. For generic OpenAI endpoints, use the "compatible/model_name" prefix.`,
    });

    this.provider = provider;
    this.supportedProviders = supportedProviders;
  }

  /**
   * Type guard to check whether an unknown error is an instance of HernexUnsupportedProviderError.
   *
   * @param error - The value to check.
   * @returns True if the error is an HernexUnsupportedProviderError, false otherwise.
   */
  static override isInstance(
    error: unknown,
  ): error is HernexUnsupportedProviderError {
    return AISDKError.hasMarker(error, unsupportedProviderMarker);
  }
}

/**
 * Error thrown when a storage operation fails.
 */
export class HernexStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HernexStoreError";
  }
}

/**
 * Error thrown when a file lock cannot be acquired or operation fails.
 */
export class HernexLockError extends Error {
  /**
   * Contested or failed lock file path.
   */
  readonly lockPath?: string | undefined;

  /**
   * Creates an instance of HernexLockError.
   *
   * @param message - Descriptive failure message.
   * @param lockPath - Optional path to the contested or failed lock file.
   */
  constructor(message: string, lockPath?: string | undefined) {
    super(message);
    this.name = "HernexLockError";
    this.lockPath = lockPath;
  }
}

/**
 * Error thrown when a checkpoint restore encounters an external conflict.
 */
export class HernexCheckpointConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HernexCheckpointConflictError";
  }
}

/**
 * Options for instantiating a HernexCheckpointRestoreError.
 */
export interface HernexCheckpointRestoreErrorOptions {
  /** The identifier of the checkpoint that failed to restore. */
  readonly checkpointId: string;
  /** Detailed error message describing the failure and compensation result. */
  readonly message: string;
  /** Relative paths in the workspace that were committed prior to the failure. */
  readonly committedPaths: readonly string[];
  /** Relative paths successfully compensated back to their pre-call states. */
  readonly compensatedPaths: readonly string[];
  /** Relative paths that failed compensation or remain in a mixed state. */
  readonly unrecoveredPaths: readonly string[];
  /** Whether all committed mutations were successfully compensated. */
  readonly isCompensated: boolean;
  /** The underlying primary error that interrupted the restore. */
  readonly originalError: Error;
  /** Secondary error encountered if compensation failed. */
  readonly compensationError?: Error | undefined;
}

/**
 * Error thrown when a multi-file checkpoint restore operation fails.
 *
 * Provides a structured partial-failure and compensation report detailing which
 * workspace paths were committed before the failure, which were compensated,
 * and which remain unrecovered.
 */
export class HernexCheckpointRestoreError extends Error {
  /** The identifier of the checkpoint that failed to restore. */
  readonly checkpointId: string;
  /** Relative paths in the workspace that were committed prior to the failure. */
  readonly committedPaths: readonly string[];
  /** Relative paths successfully compensated back to their pre-call states. */
  readonly compensatedPaths: readonly string[];
  /** Relative paths that failed compensation or remain in a mixed state. */
  readonly unrecoveredPaths: readonly string[];
  /** Whether all committed mutations were successfully compensated. */
  readonly isCompensated: boolean;
  /** The underlying primary error that interrupted the restore. */
  readonly originalError: Error;
  /** Secondary error encountered if compensation failed. */
  readonly compensationError?: Error | undefined;
  /** Compatibility array of errors preserving original and compensation errors. */
  readonly errors: readonly Error[];

  /**
   * Creates an instance of HernexCheckpointRestoreError.
   *
   * @param options - Structured restore error parameters.
   */
  constructor(options: HernexCheckpointRestoreErrorOptions) {
    super(options.message);
    this.name = "HernexCheckpointRestoreError";
    this.checkpointId = options.checkpointId;
    this.committedPaths = options.committedPaths;
    this.compensatedPaths = options.compensatedPaths;
    this.unrecoveredPaths = options.unrecoveredPaths;
    this.isCompensated = options.isCompensated;
    this.originalError = options.originalError;
    this.compensationError = options.compensationError;
    this.errors = [
      options.originalError,
      ...(options.compensationError ? [options.compensationError] : []),
    ];
  }
}
