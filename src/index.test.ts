import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent';
import { fromPartial } from '@total-typescript/shoehorn';

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

const { mockModuleLoaded, mockRunTokenBurden } = vi.hoisted(() => ({
  mockModuleLoaded: vi.fn(),
  mockRunTokenBurden: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock('./runTokenBurden.js', () => {
  mockModuleLoaded();
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

  it('lazy-loads the command implementation and delegates to it', async () => {
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
    expect(mockModuleLoaded).not.toHaveBeenCalled();

    const ctx = fromPartial<ExtensionCommandContext>({});
    await requireHandler(handler)('ignored', ctx);

    expect(mockModuleLoaded).toHaveBeenCalledOnce();
    expect(mockRunTokenBurden).toHaveBeenCalledOnce();
    expect(mockRunTokenBurden).toHaveBeenCalledWith(pi, ctx);
  });
});
