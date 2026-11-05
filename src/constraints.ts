import { ELECTRONICS } from './schema.ts';
import type { DeskObject, Outcome, SceneState, Score, TaskSpec, Violation } from './schema.ts';

const EPS = 1e-6;

interface Rect { x0: number; y0: number; x1: number; y1: number }

export function footprint(o: DeskObject): Rect {
  const rotated = o.rotation === 90 || o.rotation === 270;
  const w = rotated ? o.d : o.w;
  const d = rotated ? o.w : o.d;
  return { x0: o.x, y0: o.y, x1: o.x + w, y1: o.y + d };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > EPS &&
         Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > EPS;
}

export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
  const dy = Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
  return Math.hypot(dx, dy);
}

function onSurface(o: DeskObject): boolean {
  return o.layer === 'surface' && o.kind !== 'cable';
}

function violation(code: string, objectIds: string[], message: string): Violation {
  return { code, severity: 'hard', objectIds, message };
}

/**
 * 全部判分都在结构化坐标上做解析计算，不依赖渲染网格；
 * 因此 three.js 的分段数、相机、材质不会影响判分结果。
 */
export function evaluate(scene: SceneState, task: TaskSpec): Score {
  const hard: Violation[] = [];
  const soft: Violation[] = [];
  const objs = scene.objects;
  const placement = objs.filter(onSurface);
  const { width, depth } = scene.desk;

  for (const [kind, wanted] of Object.entries(task.required)) {
    const n = objs.filter((o) => o.kind === kind).length;
    if ((wanted ?? 0) > n) {
      hard.push(violation('required', [], `缺少 ${kind}：需要 ${wanted}，实际 ${n}`));
    }
  }

  const ids = new Set<string>();
  for (const o of objs) {
    if (ids.has(o.id)) hard.push(violation('dangling', [o.id], `重复 id ${o.id}`));
    ids.add(o.id);
  }
  for (const o of objs) {
    if (o.pluggedInto && !ids.has(o.pluggedInto)) {
      hard.push(violation('dangling', [o.id], `${o.id} 引用了不存在的插座 ${o.pluggedInto}`));
    }
  }

  for (const o of placement) {
    const r = footprint(o);
    if (r.x0 < -EPS || r.y0 < -EPS || r.x1 > width + EPS || r.y1 > depth + EPS) {
      hard.push(violation('in_bounds', [o.id], `${o.id} 超出桌面边界`));
    }
  }

  for (let i = 0; i < placement.length; i++) {
    for (let j = i + 1; j < placement.length; j++) {
      const a = placement[i];
      const b = placement[j];
      if (overlaps(footprint(a), footprint(b))) {
        hard.push(violation('no_overlap', [a.id, b.id], `${a.id} 与 ${b.id} 占位重叠`));
      }
    }
  }

  const monitors = objs.filter((o) => o.kind === 'monitor' || o.kind === 'second_monitor');
  for (const m of monitors) {
    if (footprint(m).y1 < depth - 10 - EPS) {
      hard.push(violation('anchor', [m.id], `${m.id} 未靠后墙放置`));
    }
    const mr = footprint(m);
    if (Math.abs((mr.x0 + mr.x1) / 2 - width / 2) > 6 + EPS) {
      soft.push({ code: 'symmetry', severity: 'soft', objectIds: [m.id], message: `${m.id} 未居中` });
    }
  }

  const keyboards = objs.filter((o) => o.kind === 'keyboard');
  if (monitors.length) {
    for (const k of keyboards) {
      const kr = footprint(k);
      const ok = monitors.some((m) => {
        const mr = footprint(m);
        return kr.y1 <= mr.y0 + EPS && mr.y0 - kr.y1 <= 40 + EPS;
      });
      if (!ok) hard.push(violation('ergonomics', [k.id], `${k.id} 不在显示器前方的人机区`));
    }
  }

  for (const mug of objs.filter((o) => o.kind === 'mug')) {
    const mr = footprint(mug);
    const tooClose = objs.find((e) =>
      e.id !== mug.id && ELECTRONICS.has(e.kind) && rectGap(mr, footprint(e)) < 15 - EPS);
    if (tooClose) {
      hard.push(violation('liquid', [mug.id], `${mug.id} 距 ${tooClose.id} 不足 15cm`));
    }
  }

  const strips = objs.filter((o) => o.kind === 'powerstrip');
  if (strips.length) {
    for (const o of objs.filter((x) => x.needsPower)) {
      if (o.pluggedInto && ids.has(o.pluggedInto)) continue;
      const nearest = Math.min(...strips.map((s) => rectGap(footprint(o), footprint(s))));
      if (nearest > 60 + EPS) {
        hard.push(violation('power', [o.id], `${o.id} 距最近插座 ${nearest.toFixed(1)}cm，超过 60cm`));
      }
    }
  }

  const used = placement.reduce((s, o) => {
    const r = footprint(o);
    return s + (r.x1 - r.x0) * (r.y1 - r.y0);
  }, 0);
  const ratio = used / (width * depth);
  if (ratio < 0.12 || ratio > 0.75) {
    soft.push({ code: 'utilization', severity: 'soft', objectIds: [], message: `桌面占用率 ${(ratio * 100).toFixed(0)}% 偏离舒适区间` });
  }

  return {
    pass: hard.length === 0,
    score: hard.length === 0 ? Math.max(0, 1 - soft.length * 0.05) : 0,
    hard,
    soft,
  };
}

/** 节点级校验：只把涉及本节点产出物件的硬约束反馈给该节点。 */
export function evaluateFocused(scene: SceneState, task: TaskSpec, focusIds: string[]): Violation[] {
  const focus = new Set(focusIds);
  return evaluate(scene, task).hard.filter((v) => v.objectIds.some((id) => focus.has(id)));
}

/** L3/L4 判的是"行为是否正确"，不是布局是否好看。 */
export function passOf(task: TaskSpec, score: Score, outcome: Outcome): boolean {
  if (task.expectInfeasible) return outcome.infeasible && !outcome.needsClarify;
  if (task.expectClarify) return outcome.needsClarify && !outcome.infeasible;
  return score.pass && !outcome.infeasible && !outcome.needsClarify;
}
