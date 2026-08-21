import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
import { fromPartial } from '@total-typescript/shoehorn';

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

const { mockModuleEvaluations, mockRunTokenBurden } = vi.hoisted(() => ({
  mockModuleEvaluations: { count: 0 },
  mockRunTokenBurden: vi.fn(async (): Promise<void> => undefined),
}));

// Module-evaluation sentinel: the factory body runs when the command module
// is evaluated. A static import of './runTokenBurden.js' in index.ts would
// fire it during extension load, which the registration test below forbids.
vi.mock('./runTokenBurden.js', () => {
  mockModuleEvaluations.count += 1;
  return { runTokenBurden: mockRunTokenBurden };
});

function requireHandler(handler: CommandHandler | null): CommandHandler {
  if (handler === null) {
    throw new Error('token-burden handler not registered');
  }

  return handler;
}

describe('token-burden extension entrypoint', () => {
  it('exports a default function', async () => {
    const mod = await import('./index.js');
    expectTypeOf(mod.default).toBeFunction();
  });

  it('registers /token-burden without evaluating the command module', async () => {
    let handler: CommandHandler | null = null;
    const pi = {
      registerCommand: vi.fn(
        (name: string, { handler: registeredHandler }: { handler: CommandHandler }) => {
          expect(name).toBe('token-burden');
          handler = registeredHandler;
        },
      ),
    };

    const { default: extension } = await import('./index.js');
    await extension(fromPartial(pi));

    expect(handler).toBeTypeOf('function');
    expect(mockModuleEvaluations.count).toBe(0);
  });

  it('loads the command module on first invocation and delegates to runTokenBurden', async () => {
    let handler: CommandHandler | null = null;
    const pi = {
      registerCommand: vi.fn(
        (_name: string, { handler: registeredHandler }: { handler: CommandHandler }) => {
          handler = registeredHandler;
        },
      ),
    };

    const { default: extension } = await import('./index.js');
    await extension(fromPartial(pi));

    const runHandler = requireHandler(handler);
    const ctx = fromPartial<ExtensionCommandContext>({});

    await runHandler('first', ctx);

    expect(mockModuleEvaluations.count).toBe(1);
    expect(mockRunTokenBurden).toHaveBeenCalledTimes(1);
    expect(mockRunTokenBurden).toHaveBeenCalledWith(pi, 'first', ctx);

    // ES module cache: a second invocation in the same process reuses the
    // already-loaded command module.
    await runHandler('second', ctx);

    expect(mockModuleEvaluations.count).toBe(1);
    expect(mockRunTokenBurden).toHaveBeenCalledTimes(2);
    expect(mockRunTokenBurden).toHaveBeenLastCalledWith(pi, 'second', ctx);
  });
});
