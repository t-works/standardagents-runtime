import { defineHook } from '@standardagents/spec';

/** A user-scope hook: it runs against UserState and can never be contributed to a parent. */
export default defineHook({
  hook: 'user_value_changed',
  id: 'track_presence',
  async execute() {
    // Never executed: the package is only ever loaded, to be rejected.
  },
});
