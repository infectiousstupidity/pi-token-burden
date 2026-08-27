import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

const INVENTORY_PATH_ENV = 'PI_TOOL_BENCH_INVENTORY_PATH';

export default function inventoryExtension(pi: ExtensionAPI): void {
  let written = false;

  pi.on('before_agent_start', () => {
    if (written) {
      return;
    }

    const outputPath = process.env[INVENTORY_PATH_ENV];
    if (!outputPath) {
      return;
    }

    const allTools = pi.getAllTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));
    const activeTools = pi.getActiveTools();

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(
      outputPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          allTools,
          activeTools,
        },
        null,
        2,
      ),
      'utf8',
    );
    written = true;
  });
}
