import {
  applyTurn, availableInstructions, localityLines, openSession, structuredReader,
} from './incremental.ts';
import { offlineOperator } from './operator.ts';
import { PRESETS } from './presets.ts';

const session = await openSession(structuredReader(PRESETS[0], 'preset'));

console.log('阶段 4a · 多轮增量编辑与编辑局部性（展示轨，离线算子）\n');
console.log(`起点：${session.reader.label} · 置信度 ${session.read.confidence.toFixed(2)} · ${session.initial.items.length} 件\n`);

for (const d of availableInstructions(session.initial)) {
  const turn = await applyTurn(session, d.text, { operator: offlineOperator });
  console.log(
    `第 ${turn.index} 轮「${d.text}」→ ${turn.nodeId} · 重算 ${turn.attempts} 次 · ` +
    `变化 ${turn.changedIds.length} 件 · 上游 ${turn.upstreamTouched.length} · ` +
    `${turn.pass ? 'PASS' : 'FAIL ' + turn.codes.join(',')}`,
  );
}

console.log('');
for (const line of localityLines(session)) console.log(line);
