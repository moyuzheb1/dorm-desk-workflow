import { evaluate, evaluateFocused } from './constraints.ts';
import { CATALOG, requiredKinds } from './tasks.ts';
import type {
  DeskObject, NodeContext, Operator, Outcome, Plan, SceneState, Score,
  TaskSpec, Violation, WorkflowEvent, WorkflowNode,
} from './schema.ts';

export class EventLog {
  events: WorkflowEvent[] = [];
  private checkpoints: { seq: number; scene: SceneState }[] = [];

  append(nodeId: string, status: WorkflowEvent['status'], attempt: number, detail?: string): number {
    const seq = this.events.length + 1;
    this.events.push({ seq, nodeId, status, attempt, detail });
    return seq;
  }

  checkpoint(scene: SceneState): void {
    const seq = this.append('workflow', 'checkpoint', 0, `${scene.objects.length} objects`);
    this.checkpoints.push({ seq, scene: structuredClone(scene) });
  }

  replayTo(seq: number): SceneState | null {
    let found: SceneState | null = null;
    for (const c of this.checkpoints) {
      if (c.seq > seq) break;
      found = structuredClone(c.scene);
    }
    return found;
  }

  get checkpointCount(): number {
    return this.checkpoints.length;
  }
}

/** Interpret + Plan：确定性预检，不调用 LLM。可解性与指代消解在此拦截。 */
export function analyze(task: TaskSpec): Outcome & { reason?: string } {
  const area = Object.entries(task.required).reduce((sum, [kind, count]) => {
    const c = CATALOG[kind as keyof typeof CATALOG];
    return sum + (c ? c.w * c.d * (count ?? 0) : 0);
  }, 0);
  const ratio = area / (task.desk.width * task.desk.depth);
  const contradictory = /不占用.*桌面|不占.*面积|悬浮|零占地/.test(task.prompt);
  const infeasible = ratio > 0.75 || contradictory;
  const named = /显示器|副屏|键盘|鼠标|台灯|水杯|笔记本|插座|收纳盒|书架|绿植/.test(task.prompt);
  const vague = /把它|那个|往左挪|往右挪|这个/.test(task.prompt) && !named;
  const needsClarify = !infeasible && vague;
  const reason = infeasible
    ? `需求不可行（占用率 ${(ratio * 100).toFixed(0)}% 或自相矛盾）`
    : needsClarify ? '指代不明，需要澄清' : 'ok';
  return { infeasible, needsClarify, reason };
}

const BUCKETS: { id: string; deps: string[]; kinds: ObjectKindList }[] = [
  { id: 'anchor',     deps: [],                                     kinds: ['monitor', 'second_monitor', 'laptop', 'powerstrip', 'shelf'] },
  { id: 'ergonomics', deps: ['anchor'],                             kinds: ['keyboard', 'mouse'] },
  { id: 'periphery',  deps: ['anchor'],                             kinds: ['lamp', 'mug', 'plant', 'storage'] },
  { id: 'power',      deps: ['anchor', 'ergonomics', 'periphery'],  kinds: ['cable'] },
];

type ObjectKindList = (keyof typeof CATALOG)[];

/** Kahn 分层：同一层的节点互不依赖，可并行执行。 */
export function layerize(nodes: WorkflowNode[]): string[][] {
  const done = new Set<string>();
  const remaining = [...nodes];
  const groups: string[][] = [];
  while (remaining.length) {
    const ready = remaining.filter((n) => n.deps.every((d) => done.has(d))).map((n) => n.id);
    if (!ready.length) throw new Error('workflow DAG 中存在环');
    groups.push(ready);
    for (const id of ready) done.add(id);
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (ready.includes(remaining[i].id)) remaining.splice(i, 1);
    }
  }
  return groups;
}

export function plan(task: TaskSpec): Plan {
  const required = new Set(requiredKinds(task));
  const nodes: WorkflowNode[] = BUCKETS
    .map((b) => ({
      id: b.id,
      phase: 'build' as const,
      deps: b.deps.filter((d) => BUCKETS.some((x) => x.id === d && x.kinds.some((k) => required.has(k)))),
      kinds: b.kinds.filter((k) => required.has(k)),
    }))
    .filter((n) => n.kinds.length > 0);
  return { nodes, groups: layerize(nodes) };
}

function merge(scene: SceneState, objects: DeskObject[], kinds: (keyof typeof CATALOG)[]): void {
  const owned = new Set(kinds);
  scene.objects = scene.objects.filter((o) => !owned.has(o.kind)).concat(objects);
}

export interface RunOptions {
  operator: Operator;
  maxAttempts?: number;
  stepDelayMs?: number;
}

export interface WorkflowResult {
  scene: SceneState;
  score: Score;
  outcome: Outcome;
  log: EventLog;
  groups: string[][];
  recomputed: number;
  totalNodes: number;
}

async function delay(ms: number): Promise<void> {
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

async function invoke(
  node: WorkflowNode, task: TaskSpec, snapshot: SceneState, operator: Operator,
  log: EventLog, attempt: number, violations: Violation[], stepDelayMs: number,
): Promise<DeskObject[]> {
  log.append(node.id, 'running', attempt);
  await delay(stepDelayMs);
  const ctx: NodeContext = {
    task, scene: structuredClone(snapshot), nodeId: node.id,
    kinds: node.kinds, attempt, violations,
  };
  const out = await operator(ctx);
  return out.objects;
}

/**
 * 组内并行生成 → 按确定顺序合并 → 整组校验 → 只重算被归责的节点。
 * 并行节点在各自快照上工作，合并由编排器串行完成，因此无写竞态。
 */
export async function runWorkflow(task: TaskSpec, options: RunOptions): Promise<WorkflowResult> {
  const log = new EventLog();
  const scene: SceneState = { desk: { ...task.desk }, objects: [] };
  const checked = analyze(task);
  const outcome: Outcome = { infeasible: checked.infeasible, needsClarify: checked.needsClarify };
  const { nodes, groups } = plan(task);
  const maxAttempts = options.maxAttempts ?? 3;
  const stepDelayMs = options.stepDelayMs ?? 0;

  log.append('interpret', 'interpret', 0, checked.reason);
  if (outcome.infeasible || outcome.needsClarify) {
    for (const n of nodes) log.append(n.id, 'skipped', 0, checked.reason);
    return { scene, score: evaluate(scene, task), outcome, log, groups, recomputed: 0, totalNodes: nodes.length };
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const recomputedNodes = new Set<string>();

  for (const group of groups) {
    const groupNodes = group.map((id) => byId.get(id)!);
    const groupKinds = new Set(groupNodes.flatMap((n) => n.kinds));
    const ownerOf = new Map<string, string>();
    const snapshot = structuredClone(scene);

    const produced = await Promise.all(groupNodes.map(async (n) => ({
      node: n,
      objects: await invoke(n, task, snapshot, options.operator, log, 1, [], stepDelayMs),
    })));
    for (const r of produced) {
      merge(scene, r.objects, r.node.kinds);
      for (const o of r.objects) ownerOf.set(o.id, r.node.id);
    }

    const focusIds = scene.objects.filter((o) => groupKinds.has(o.kind)).map((o) => o.id);
    let violations = evaluateFocused(scene, task, focusIds);

    for (let round = 1; violations.length && round < maxAttempts; round++) {
      const blamed = new Set<string>();
      for (const v of violations) {
        for (const id of v.objectIds) {
          const owner = ownerOf.get(id);
          if (owner) blamed.add(owner);
        }
      }
      // 修复阶段串行：每个节点基于最新状态重算，避免并行修复互相撞位。
      for (const n of groupNodes.filter((x) => blamed.has(x.id))) {
        const own = violations.filter((v) => v.objectIds.some((id) => ownerOf.get(id) === n.id));
        if (!own.length) continue;
        const objects = await invoke(n, task, structuredClone(scene), options.operator, log, round + 1, own, stepDelayMs);
        merge(scene, objects, n.kinds);
        recomputedNodes.add(n.id);
        violations = evaluateFocused(scene, task, focusIds);
      }
    }

    for (const n of groupNodes) {
      const last = log.events.filter((e) => e.nodeId === n.id && e.status === 'running').at(-1);
      const stillBroken = violations.filter((v) => v.objectIds.some((id) => ownerOf.get(id) === n.id));
      log.append(n.id, stillBroken.length ? 'failed' : 'done', last?.attempt ?? 1,
        stillBroken.length ? stillBroken.map((v) => v.code).join(',') : undefined);
    }
    log.checkpoint(scene);
  }

  return {
    scene, score: evaluate(scene, task), outcome, log, groups,
    recomputed: recomputedNodes.size, totalNodes: nodes.length,
  };
}

/** 对照基线：同一个算子，一次性端到端生成，无预检、无依赖分组、无校验反馈。 */
export async function runBaseline(
  task: TaskSpec, options: RunOptions,
): Promise<{ scene: SceneState; score: Score; outcome: Outcome }> {
  await delay(options.stepDelayMs ?? 0);
  const out = await options.operator({
    task,
    scene: { desk: { ...task.desk }, objects: [] },
    nodeId: 'baseline', kinds: requiredKinds(task), attempt: 1, violations: [],
  });
  const scene: SceneState = { desk: { ...task.desk }, objects: out.objects };
  return {
    scene,
    score: evaluate(scene, task),
    outcome: { infeasible: !!out.infeasible, needsClarify: !!out.needsClarify },
  };
}
