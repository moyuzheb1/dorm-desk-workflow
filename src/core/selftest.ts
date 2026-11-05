import { DEFAULT_OPTIONS, grade, INJECTIONS } from './grade.ts';
import type { GradeOptions } from './grade.ts';
import { PRESETS } from './presets.ts';
import { buildTrace } from './trace.ts';
import {
  applyTurn, availableInstructions, currentSceneOf, diffScenes, localityReport,
  openSession, routeInstruction, structuredReader,
} from './incremental.ts';
import { offlineOperator } from './operator.ts';
import type { Scene, ViolationCode } from './types.ts';

const expected: Record<string, ViolationCode[] | null> = {
  'single': null,
  'laptop-shelf': null,
  'dual': ['clearance'],
  'narrow': ['bounds'],
};

let failures = 0;

function check(ok: boolean, line: string): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${line}`);
}

console.log('阶段 1 + 2 · 立体判分与工作流轨迹自测\n');

console.log('预设现状（评测轨）');
for (const scene of PRESETS) {
  const g = grade(scene);
  const codes = [...new Set(g.hard.map((x) => x.code))];
  const want = expected[scene.space.id] ?? null;
  check(want ? want.every((c) => codes.includes(c)) : g.pass,
    `${scene.space.id.padEnd(14)} ${g.pass ? 'PASS' : 'FAIL'} ${g.score.toFixed(2)}  ${codes.join(',') || '-'}`);
}

console.log('\n注入违规（每一类都必须被抓到）');
for (const inj of INJECTIONS) {
  const scene = structuredClone(PRESETS[0]);
  inj.apply(scene);
  const g = grade(scene);
  check(g.hard.some((x) => x.code === inj.code), `${inj.label.padEnd(16)} → ${inj.code}`);
}

console.log('\n约束滑块敏感性（调阈值必须改变判分）');
const sensitivity: { label: string; scene: Scene; options: GradeOptions; expect: ViolationCode }[] = [
  { label: '安全距离 → 40cm', scene: PRESETS[0], options: { ...DEFAULT_OPTIONS, liquidGap: 40 }, expect: 'liquid' },
  { label: '伸手半径 → 10cm', scene: PRESETS[0], options: { ...DEFAULT_OPTIONS, reachDepth: 10 }, expect: 'reach' },
  { label: '可用宽度 → 60%', scene: PRESETS[0], options: { ...DEFAULT_OPTIONS, usableRatio: 0.6 }, expect: 'bounds' },
  { label: '屏幕净空 → 70cm', scene: PRESETS[0], options: { ...DEFAULT_OPTIONS, screenHeadroom: 70 }, expect: 'clearance' },
];
for (const t of sensitivity) {
  const g = grade(t.scene, t.options);
  check(g.hard.some((x) => x.code === t.expect), `${t.label.padEnd(16)} → ${t.expect}`);
}

console.log('\n工作流帧轨迹（手工节点事件，不接 AI）');
const trace = buildTrace();
const expectedFrame: ('pass' | 'liquid')[] = ['pass', 'pass', 'liquid', 'liquid', 'pass', 'pass'];
for (let i = 0; i < trace.frames.length; i++) {
  const f = trace.frames[i];
  const g = grade({ space: trace.space, items: f.items });
  const hasLiquid = g.hard.some((x) => x.code === 'liquid');
  const ok = expectedFrame[i] === 'liquid' ? hasLiquid : g.pass;
  const codes = [...new Set(g.hard.map((x) => x.code))];
  check(ok, `帧 ${i} ${f.nodeId.padEnd(12)} ${g.pass ? 'PASS' : 'FAIL'}  ${codes.join(',') || '-'}`);
}

console.log('\n局部重算（verify → repair 只允许一个物件变化）');
const before = trace.frames[3].items;
const after = trace.frames[4].items;
const changedIds = after.filter((a) => {
  const b = before.find((x) => x.id === a.id);
  return !b || JSON.stringify(a.box) !== JSON.stringify(b.box);
}).map((a) => a.id);
check(changedIds.length === 1 && changedIds[0] === 'mug',
  `变化物件：${changedIds.join(',') || '无'}（应为 mug）`);

console.log('\n多轮增量编辑局部性（阶段 4a，展示轨）');
const inc = await openSession(structuredReader(PRESETS[0], 'preset'));
check(inc.read.confidence === 1 && inc.read.notes.length === 0,
  '预设现状自洽校验通过（置信度 1.00）');
for (const d of availableInstructions(inc.initial)) {
  const route = routeInstruction(d.text, currentSceneOf(inc));
  const turn = await applyTurn(inc, d.text, { operator: offlineOperator });
  const inScope = turn.changedIds.every((id) => {
    const it = turn.after.items.find((x) => x.id === id) ?? turn.before.items.find((x) => x.id === id);
    return !!it && route.kinds.includes(it.kind);
  });
  check(turn.upstreamTouched.length === 0 && inScope && turn.pass,
    `第 ${turn.index} 轮 ${d.text} → ${turn.nodeId} · 变化 ${turn.changedIds.length} 件 · 上游 ${turn.upstreamTouched.length} · ${turn.pass ? 'PASS' : 'FAIL'}`);
}
const locality = localityReport(inc);
check(locality.upstreamTotal === 0, `累计上游触碰 ${locality.upstreamTotal} 次（应为 0）`);
check(locality.changedTotal > 0 && locality.changedTotal < locality.itemCount * locality.turns,
  `累计变化 ${locality.changedTotal}/${locality.itemCount * locality.turns} 件次，确实只动局部`);

console.log('\n现状校验与兜底（读现状节点）');
const narrowRead = await structuredReader(PRESETS[3], 'preset').read();
check(narrowRead.confidence < 1 && narrowRead.notes.length > 0,
  `极窄桌现状检出 ${narrowRead.notes.length} 处问题，置信度 ${narrowRead.confidence.toFixed(2)} → 低置信度确认槽`);
const brokenScene = structuredClone(PRESETS[0]);
brokenScene.items[0].box.w = -5;
const manualRead = await structuredReader(brokenScene, 'manual').read();
check(manualRead.confidence < 1 && manualRead.notes.some((n) => n.includes('尺寸非正')),
  '手动录入现状的自洽校验能拦住非法尺寸');
const moved = structuredClone(PRESETS[0]);
moved.items.find((i) => i.id === 'mug')!.box.x += 10;
check(diffScenes(PRESETS[0], moved).join(',') === 'mug', 'checkpoint diff 只报出被移动的物件');

if (failures > 0) throw new Error(`自测未通过：${failures} 项`);
console.log(`\n全部通过：${PRESETS.length} 个预设、${INJECTIONS.length} 类注入、${sensitivity.length} 项滑块敏感性、${trace.frames.length} 帧轨迹、${locality.turns} 轮增量编辑与现状校验兜底`);
