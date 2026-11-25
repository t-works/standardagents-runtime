// The broken packages only exist to be rejected at load time; they still need a
// model for their prompts to resolve, so they reuse the baseline one.
export { default } from '../../../fixtures/models/scripted.ts';
