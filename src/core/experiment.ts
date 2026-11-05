import { makeItem } from './catalog.ts';
import { DEFAULT_OPTIONS, grade } from './grade.ts';
import { safeSurfaceId, toExisting } from './operator.ts';
import { PRESETS } from './presets.ts';
import type { Operator, Placement, PlacementRequest } from './operator.ts';
import type { BoxItem, ItemKind, SpaceSpec, Violation, ViolationCode } from './types.ts';

/** 节点分组：评测轨与展示轨共用，保证"只换读现状那一个节点"。 */
export const GROUPS: { nodeId: string; kinds: ItemKind[] }[] = [
  { nodeId: 'anchor', kinds: ['monitor', 'second_monitor', 'laptop', 'powerstrip', 'hanger', 'book'] },
  { nodeId: 'ergonomics', kinds: ['keyboard', 'mouse'] },
  { nodeId: 'periphery', kinds: ['lamp', 'mug', 'storage', 'plant', 'riser'] },
];

export interface ExperimentTask {
  id: string;
  label: string;
  prompt: string;
  space: SpaceSpec;
  kinds: ItemKind[];
  groups: { nodeId: string; kinds: ItemKind[] }[];
}

/** 评测轨任务由 4 个结构化预设现状派生，保证可复现、无需人工干预。 */
export const EVAL_TASKS: ExperimentTask[] = PRESETS.map((p) => {
  /** 同类多件（两本书）去重成一种，避免算子按 kind 生成时撞出重复 id。 */
  const kinds = [...new Set(p.items.map((i) => i.kind))];
  return {
    id: p.space.id,
    label: p.space.label,
    prompt: `为「${p.space.label}」重新规划桌面布局，需要放置：${kinds.join('、')}`,
    space: p.space,
    kinds,
    groups: GROUPS
      .map((g) => ({ nodeId: g.nodeId, kinds: g.kinds.filter((k) => kinds.includes(k)) }))
      .filter((g) => g.kinds.length > 0),
  };
});

export interface RunResult {
  taskId: string;
  label: string;
  arm: 'baseline' | 'workflow';
  pass: boolean;
  score: number;
  codes: ViolationCode[];
  recomputed: number;
  totalNodes: number;
  latencyMs: number;
  tokens: number;
  error?: string;
}

export interface ExperimentReport {
  source: 'offline' | 'model';
  model?: string;
  autoApprove: boolean;
  rows: RunResult[];
  summary: {
    total: number;
    baselinePass: number;
    workflowPass: number;
    baselineCodes: Record<string, number>;
    workflowCodes: Record<string, number>;
    recomputed: number;
    totalNodes: number;
    tokens: number;
    latencyMs: number;
  };
}

function toItems(space: SpaceSpec, placements: Placement[]): BoxItem[] {
  return placements.map((p) =>
    makeItem(space, p.id, p.id as ItemKind, safeSurfaceId(space, p.surfaceId), p.x, p.z, p.lift));
}

function missingKinds(task: ExperimentTask, items: BoxItem[]): string[] {
  return task.kinds.filter((k) => !items.some((i) => i.kind === k));
}

async function runBaseline(task: ExperimentTask, operator: Operator): Promise<RunResult> {
  const req: PlacementRequest = {
    task: task.prompt, nodeId: 'baseline', kinds: task.kinds,
    space: task.space, existing: [], attempt: 1,
  };
  const res = await operator(req);
  const items = toItems(task.space, res.placements);
  const g = grade({ space: task.space, items }, DEFAULT_OPTIONS);
  const missing = missingKinds(task, items);
  return {
    taskId: task.id, label: task.label, arm: 'baseline',
    pass: g.pass && missing.length === 0,
    score: g.score,
    codes: [...new Set(g.hard.map((v) => v.code))],
    recomputed: 0, totalNodes: 1,
    latencyMs: res.latencyMs, tokens: res.tokens,
    error: res.error ?? (missing.length ? `缺失物件：${missing.join(',')}` : undefined),
  };
}

async function runWorkflow(task: ExperimentTask, operator: Operator, maxAttempts: number): Promise<RunResult> {
  let items: BoxItem[] = [];
  let recomputed = 0;
  let latencyMs = 0;
  let tokens = 0;
  let firstError: string | undefined;

  for (const group of task.groups) {
    let attempt = 1;
    let lastViolations: Violation[] = [];
    while (attempt <= maxAttempts) {
      const req: PlacementRequest = {
        task: task.prompt, nodeId: group.nodeId, kinds: group.kinds, space: task.space,
        existing: toExisting(items, task.space),
        attempt,
        violations: attempt > 1 ? lastViolations : undefined,
      };
      const res = await operator(req);
      latencyMs += res.latencyMs;
      tokens += res.tokens;
      if (res.error && !firstError) firstError = res.error;

      const produced = toItems(task.space, res.placements.filter((p) => group.kinds.includes(p.id as ItemKind)));
      const merged = items.filter((i) => !group.kinds.includes(i.kind)).concat(produced);
      const focus = new Set(produced.map((i) => i.id));
      const violations = grade({ space: task.space, items: merged }, DEFAULT_OPTIONS)
        .hard.filter((v) => v.objectIds.some((id) => focus.has(id)));
      items = merged;
      if (!violations.length) break;
      lastViolations = violations;
      if (attempt < maxAttempts) recomputed++;
      attempt++;
    }
  }

  const g = grade({ space: task.space, items }, DEFAULT_OPTIONS);
  const missing = missingKinds(task, items);
  return {
    taskId: task.id, label: task.label, arm: 'workflow',
    pass: g.pass && missing.length === 0,
    score: g.score,
    codes: [...new Set(g.hard.map((v) => v.code))],
    recomputed, totalNodes: task.groups.length,
    latencyMs, tokens,
    error: firstError ?? (missing.length ? `缺失物件：${missing.join(',')}` : undefined),
  };
}

export interface ExperimentOptions {
  source: 'offline' | 'model';
  model?: string;
  maxAttempts?: number;
  /** 评测轨：人工节点一律自动通过，保证路径可复现 */
  autoApprove?: boolean;
}

export async function runExperiment(
  tasks: ExperimentTask[], operator: Operator, opts: ExperimentOptions,
): Promise<ExperimentReport> {
  const rows: RunResult[] = [];
  const maxAttempts = opts.maxAttempts ?? 3;
  for (const task of tasks) {
    rows.push(await runBaseline(task, operator));
    rows.push(await runWorkflow(task, operator, maxAttempts));
  }

  const baseline = rows.filter((r) => r.arm === 'baseline');
  const workflow = rows.filter((r) => r.arm === 'workflow');
  const tally = (rs: RunResult[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const r of rs) for (const c of r.codes) out[c] = (out[c] ?? 0) + 1;
    return out;
  };

  return {
    source: opts.source,
    model: opts.model,
    autoApprove: opts.autoApprove ?? true,
    rows,
    summary: {
      total: tasks.length,
      baselinePass: baseline.filter((r) => r.pass).length,
      workflowPass: workflow.filter((r) => r.pass).length,
      baselineCodes: tally(baseline),
      workflowCodes: tally(workflow),
      recomputed: workflow.reduce((s, r) => s + r.recomputed, 0),
      totalNodes: workflow.reduce((s, r) => s + r.totalNodes, 0),
      tokens: rows.reduce((s, r) => s + r.tokens, 0),
      latencyMs: rows.reduce((s, r) => s + r.latencyMs, 0),
    },
  };
}

export function reportLines(report: ExperimentReport): string[] {
  const lines: string[] = [];
  lines.push(`对照实验 · ${report.source === 'offline' ? '离线演示算子（未调用模型）' : `OpenRouter ${report.model ?? ''}`}`);
  lines.push('任务        端到端一次生成        工作流分步编排        重算');
  const ids = [...new Set(report.rows.map((r) => r.taskId))];
  for (const id of ids) {
    const b = report.rows.find((r) => r.taskId === id && r.arm === 'baseline')!;
    const w = report.rows.find((r) => r.taskId === id && r.arm === 'workflow')!;
    lines.push(
      `${id.padEnd(13)}${(b.pass ? 'PASS' : 'FAIL') + ' ' + (b.codes.join(',') || '-')}`.padEnd(23) +
      `${(w.pass ? 'PASS' : 'FAIL') + ' ' + (w.codes.join(',') || '-')}`.padEnd(23) +
      `${w.recomputed}/${w.totalNodes}`,
    );
  }
  const s = report.summary;
  lines.push('');
  lines.push(`端到端 ${s.baselinePass}/${s.total} PASS　工作流 ${s.workflowPass}/${s.total} PASS`);
  lines.push(`baseline 失败归因 ${JSON.stringify(s.baselineCodes)}`);
  lines.push(`workflow 失败归因 ${JSON.stringify(s.workflowCodes)}`);
  lines.push(`局部重算 ${s.recomputed}/${s.totalNodes} 节点　tokens ${s.tokens}　耗时 ${s.latencyMs.toFixed(0)}ms`);
  lines.push(`人工节点 ${report.autoApprove ? '自动通过（评测轨）' : '需人工确认（展示轨）'}`);
  const errors = [...new Set(report.rows.map((r) => r.error).filter((e): e is string => !!e))];
  if (errors.length) lines.push(`算子错误（前 3 条）：${errors.slice(0, 3).map((e) => e.slice(0, 220)).join(' | ')}`);
  if (report.source === 'offline') {
    lines.push('注意：以上为确定性演示桩数据，仅用于验证管线，不能作为简历数字；USE_OPENROUTER=1 且提供有效 OPENROUTER_API_KEY 后重跑才是模型结果。');
  }
  return lines;
}
