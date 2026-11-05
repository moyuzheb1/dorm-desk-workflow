import { footprint, overlaps, passOf, rectGap } from './constraints.ts';
import { runBaseline, runWorkflow } from './dag.ts';
import { CATALOG, TASKS } from './tasks.ts';
import { ELECTRONICS } from './schema.ts';
import type { DeskObject, NodeContext, NodeOutput, ObjectKind, SceneState, TaskSpec } from './schema.ts';

/**
 * W1 占位算子：确定性启发式布局器，故意不调用 LLM。
 * baseline 与 workflow 使用同一个算子，因此对照实验里的差异只可能来自编排本身。
 * 接入真实模型时只需替换这个函数，编排器与判分器都不用改。
 */
function findFreeSpot(
  o: DeskObject, scene: SceneState, task: TaskSpec, fixed: DeskObject[], ownKinds: ObjectKind[],
): { x: number; y: number } | null {
  const { width, depth } = task.desk;
  const r0 = footprint(o);
  const w = r0.x1 - r0.x0;
  const d = r0.y1 - r0.y0;
  const isMonitor = o.kind === 'monitor' || o.kind === 'second_monitor';
  const others = [
    ...scene.objects.filter((x) => !ownKinds.includes(x.kind) && x.layer === 'surface' && x.kind !== 'cable'),
    ...fixed.filter((x) => x.id !== o.id && x.layer === 'surface' && x.kind !== 'cable'),
  ];
  const strips = others.filter((x) => x.kind === 'powerstrip');
  const monitors = others.filter((x) => x.kind === 'monitor' || x.kind === 'second_monitor');

  const xs: number[] = [];
  for (let x = 1; x <= width - w - 1; x += 3) xs.push(x);
  if (isMonitor) {
    const center = (width - w) / 2;
    xs.sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
  }

  for (const x of xs) {
    for (let y = 1; y <= depth - d - 1; y += 3) {
      if (isMonitor && y + d < depth - 10) continue;
      const cr = footprint({ ...o, x, y });
      if (cr.x1 > width || cr.y1 > depth) continue;
      if (others.some((t) => overlaps(cr, footprint(t)))) continue;
      if (o.kind === 'mug' && others.some((t) => ELECTRONICS.has(t.kind) && rectGap(cr, footprint(t)) < 15)) continue;
      if (o.needsPower && strips.length && Math.min(...strips.map((s) => rectGap(cr, footprint(s)))) > 60) continue;
      if (o.kind === 'keyboard' && monitors.length) {
        const ok = monitors.some((m) => {
          const mr = footprint(m);
          return cr.y1 <= mr.y0 && mr.y0 - cr.y1 <= 40;
        });
        if (!ok) continue;
      }
      return { x, y };
    }
  }
  return null;
}

function heuristicOperator(ctx: NodeContext): NodeOutput {
  const seen: Partial<Record<ObjectKind, number>> = {};
  const objects: DeskObject[] = [];
  for (const kind of ctx.kinds) {
    const i = (seen[kind] ?? 0) + 1;
    seen[kind] = i;
    const c = CATALOG[kind];
    objects.push({
      id: `${kind}-${i}`, kind, w: c.w, d: c.d, x: c.x, y: c.y,
      rotation: 0, layer: c.layer, needsPower: c.needsPower,
    });
  }

  if (ctx.attempt === 1 || ctx.violations.length === 0) return { objects };

  const fixed = objects.map((o) => ({ ...o }));
  const visited = new Set<string>();
  for (const v of ctx.violations) {
    for (const id of v.objectIds) {
      const o = fixed.find((x) => x.id === id);
      if (!o || visited.has(o.id)) continue;
      visited.add(o.id);
      const spot = findFreeSpot(o, ctx.scene, ctx.task, fixed, ctx.kinds);
      if (spot) { o.x = spot.x; o.y = spot.y; }
    }
  }
  return { objects: fixed, note: 'repair' };
}

interface Row {
  task: TaskSpec;
  bPass: boolean;
  wPass: boolean;
  baseScore: number;
  wfScore: number;
  codes: string;
  baseCodes: string[];
  result: Awaited<ReturnType<typeof runWorkflow>>;
}

async function main(): Promise<void> {
  const active = TASKS.filter((t) => t.level !== 'L5');
  const rows: Row[] = [];

  for (const task of active) {
    const base = await runBaseline(task, { operator: heuristicOperator });
    const wf = await runWorkflow(task, { operator: heuristicOperator, maxAttempts: 3 });
    const baseCodes = [...new Set(base.score.hard.map((v) => v.code))];
    rows.push({
      task,
      bPass: passOf(task, base.score, base.outcome),
      wPass: passOf(task, wf.score, wf.outcome),
      baseScore: base.score.score,
      wfScore: wf.score.score,
      codes: baseCodes.join(',') || '-',
      baseCodes,
      result: wf,
    });
  }

  console.log('宿舍桌面布局 · W1 对照实验：baseline(端到端单 prompt) vs workflow(DAG 编排)');
  console.log('算子：确定性启发式 stub（未调用 LLM），两组完全同一算子\n');
  console.log('任务   层级   baseline        workflow          重算    baseline 失败码');
  for (const r of rows) {
    const behavioral = !!(r.task.expectInfeasible || r.task.expectClarify);
    const bCell = behavioral ? `${r.bPass ? 'PASS' : 'FAIL'}  n/a` : `${r.bPass ? 'PASS' : 'FAIL'} ${r.baseScore.toFixed(2)}`;
    const wCell = behavioral ? `${r.wPass ? 'PASS' : 'FAIL'}  n/a` : `${r.wPass ? 'PASS' : 'FAIL'} ${r.wfScore.toFixed(2)}`;
    console.log(
      r.task.id.padEnd(6) + r.task.level.padEnd(6) +
      bCell.padEnd(16) + wCell.padEnd(19) +
      `${r.result.recomputed}/${r.result.totalNodes}`.padEnd(7) + r.codes.slice(0, 48),
    );
  }

  const bWin = rows.filter((r) => r.bPass).length;
  const wWin = rows.filter((r) => r.wPass).length;
  const totalNodes = rows.reduce((s, r) => s + r.result.totalNodes, 0);
  const recomputed = rows.reduce((s, r) => s + r.result.recomputed, 0);
  const totalGroups = rows.reduce((s, r) => s + r.result.groups.length, 0);
  const widest = Math.max(...rows.flatMap((r) => r.result.groups.map((g) => g.length)));

  const byCode = new Map<string, number>();
  for (const r of rows) {
    if (r.task.expectInfeasible || r.task.expectClarify) continue;
    for (const c of r.baseCodes) byCode.set(c, (byCode.get(c) ?? 0) + 1);
  }

  console.log(`\nbaseline  ${bWin}/${rows.length} PASS`);
  console.log(`workflow  ${wWin}/${rows.length} PASS`);
  console.log(`baseline 失败归因  ${[...byCode].map(([k, v]) => `${k} x${v}`).join(', ') || '-'}`);
  console.log(`局部重算  ${recomputed}/${totalNodes} 节点 = ${(100 * recomputed / totalNodes).toFixed(1)}%`);
  console.log(`并行调度  ${totalGroups} 组 / ${totalNodes} 节点，最大组宽 ${widest}，理论并行度 ${(totalNodes / totalGroups).toFixed(2)}x`);
  console.log('          生成阶段按依赖分层并行；冲突修复阶段串行，避免并行修复互相撞位');

  const sample = rows.find((r) => r.result.log.checkpointCount > 0);
  if (sample) {
    const log = sample.result.log;
    const firstCp = log.events.find((e) => e.status === 'checkpoint');
    const lastSeq = log.events.at(-1)?.seq ?? 0;
    const mid = log.replayTo(firstCp?.seq ?? lastSeq);
    const end = log.replayTo(lastSeq);
    console.log(`事件日志  ${log.events.length} 条 / ${log.checkpointCount} 个 checkpoint；回放 #${firstCp?.seq} → ${mid?.objects.length} 物件，末帧 → ${end?.objects.length} 物件`);
  }

  console.log('\n注：L3/L4 判的是"是否正确报告不可行 / 请求澄清"，布局分不适用（n/a）。');
  console.log('注：延迟模拟关闭，性能与成本数字需接入真实 LLM 算子后测量。');
  console.log('注：L5 多轮增量编辑（局部 patch / 编辑局部性指标）留待 W3 接入。');
}

await main();
