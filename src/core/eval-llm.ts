import { EVAL_TASKS, reportLines, runExperiment } from './experiment.ts';
import { DEFAULT_MODEL, createModelOperator, directCaller, offlineOperator } from './operator.ts';

const env = (globalThis as unknown as {
  process?: { env: Record<string, string | undefined> };
}).process?.env ?? {};
const key = env.OPENROUTER_API_KEY;
const model = env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
const requested = env.USE_OPENROUTER === '1' || env.USE_OPENROUTER === 'true';
const useModel = requested && !!key;
const operator = useModel ? createModelOperator(directCaller(key!, model)) : offlineOperator;

if (requested && !key) console.log('提示：已请求启用模型，但未设置 OPENROUTER_API_KEY，本次改跑离线演示算子。\n');
console.log(useModel
  ? `算子：OpenRouter · ${model}\n`
  : '算子：离线演示（默认；真实模型需 USE_OPENROUTER=1 且提供有效 OPENROUTER_API_KEY）\n');

const report = await runExperiment(EVAL_TASKS, operator, {
  source: useModel ? 'model' : 'offline',
  model,
  autoApprove: true,
});
for (const line of reportLines(report)) console.log(line);
