import type { ExtensionFactory } from '@mariozechner/pi-coding-agent';

const EXTENSION: ExtensionFactory = (pi) => {
  pi.registerCommand('token-burden', {
    description: 'Show token budget breakdown and manage skills',
    handler: async (_args, ctx) => {
      const { runTokenBurden } = await import('./runTokenBurden.js');
      await runTokenBurden(pi, ctx);
    },
  });
};

/** Pi extension entrypoint required by the extension loader. */
export default EXTENSION;
