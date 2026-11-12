/**
 * @fileoverview Stream content and reasoning event definitions for agent generation.
 * @packageDocumentation
 */

/**
 * Event emitted when a textual token delta is streamed from the model.
 *
 * @example
 * ```typescript
 * if (event.type === 'tokenDelta') {
 *   process.stdout.write(event.text);
 * }
 * ```
 */
export interface TokenDeltaEvent {
  /** Discriminant event type. */
  readonly type: "tokenDelta";
  /** The streamed textual token slice. */
  readonly text: string;
  /** Optional message identifier associated with the streaming token. */
  readonly messageId?: string;
}

/**
 * Event emitted when a reasoning or thinking delta is streamed from the model.
 *
 * @example
 * ```typescript
 * if (event.type === 'thoughtDelta') {
 *   console.log('[Thinking]', event.text);
 * }
 * ```
 */
export interface ThoughtDeltaEvent {
  /** Discriminant event type. */
  readonly type: "thoughtDelta";
  /** The streamed reasoning token slice. */
  readonly text: string;
  /** Optional message identifier associated with the reasoning token. */
  readonly messageId?: string;
}
