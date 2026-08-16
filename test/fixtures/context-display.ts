/**
 * Fixture for `context-display.test.ts`: one exported binding per builder
 * shape whose hover rendering we pin. The test type-checks this file with
 * the compiler API and asserts on `checker.typeToString` of each
 * binding's context type argument — the same string an editor shows on
 * hover.
 *
 * Keep the exports small and the schemas inline: every property here ends
 * up spelled out in an expected string.
 */
import { z } from 'zod';

import { SequenceBuilder } from '../../src/lib/builder.js';

type Input = { key: string; bucket: string };

const LoadInput = z.object({ key: z.string() });
const LoadOutput = z.object({
  fileUpload: z.object({ id: z.string(), filename: z.string() }),
});

const loadConfig = {
  inputSchema: LoadInput,
  outputSchema: LoadOutput,
  functionArn: 'arn:aws:lambda:us-east-1:1:function:load',
};

export const afterOneTask = new SequenceBuilder<Input>().task(
  'loadFile',
  loadConfig,
  (ctx) => ({ key: ctx.key }),
);

export const afterThreeTasks = new SequenceBuilder<Input>()
  .task('loadFile', loadConfig, (ctx) => ({ key: ctx.key }))
  .task('second', loadConfig, (ctx) => ({ key: ctx.key }))
  .task('third', loadConfig, (ctx) => ({ key: ctx.key }));

export const afterPass = new SequenceBuilder<Input>().pass(
  'reshape',
  (ctx) => ({ id: ctx.key }),
);

export const afterCustomTask = new SequenceBuilder<Input>().customTask(
  'submit',
  {
    resource: 'arn:aws:states:::batch:submitJob',
    parameters: (ctx) => ({ JobName: ctx.key }),
    resultPath: '$.job',
    outputSchema: z.object({ JobId: z.string() }),
  },
);

export const afterMap = new SequenceBuilder<{ scenes: { id: string }[] }>().map(
  'processScenes',
  {
    items: (ctx) => ctx.scenes,
    itemSelector: (item) => ({ scene: item.value }),
    processor: (b) => b.pass('echo', (ctx) => ({ id: ctx.scene.id })),
  },
);

export const afterParallel = new SequenceBuilder<Input>().parallel('fanOut', [
  (b) => b.pass('left', (ctx) => ({ a: ctx.key })),
  (b) => b.pass('right', (ctx) => ({ b: ctx.bucket })),
]);

/** A repeated state name replaces its earlier entry rather than intersecting. */
export const afterOverwrite = new SequenceBuilder<Input>()
  .pass('slot', () => ({ old: 'x' }))
  .pass('slot', () => ({ fresh: 1 }));
