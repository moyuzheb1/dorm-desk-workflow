import { makeItem } from './catalog.ts';
import { GROUPS } from './experiment.ts';
import { DEFAULT_OPTIONS, grade } from './grade.ts';
import type { GradeOptions } from './grade.ts';
import { safeSurfaceId, toExisting } from './operator.ts';
import type { Operator, PlacementRequest } from './operator.ts';
import type { BoxItem, ItemKind, Scene, Violation, ViolationCode } from './types.ts';

/**
 * 阶段 4a：多轮增量编辑（展示轨）。
 * 上游零触碰由编排结构保证 —— 每轮只重算被归责节点的物件，其余物件原样带入下一轮；
 * 局部性指标是为了验证这个保证没被打破，不是"模型自己学会了只动一块"。
 * 离线算子即可跑通全流程，换真实算子不需要改编排。
 */

/* ---------- 读现状：工作流最前面那个可替换节点 ---------- */

export interface ReadResult {
  scene: Scene;
  confidence: number;
  source: string;
  /** 现状自洽校验的问题列表；非空即低置信度，应触发人工确认（决策 3）。 */
  notes: string[];
}

export interface SceneReader {
  id: string;
  label: string;
  read(): Promise<ReadResult> | ReadResult;
}

/** 决策 3：结构化现状先过一道自洽校验，不让坏数据进工作流。 */
export function validateScene(scene: Scene): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const it of scene.items) {
    if (seen.has(it.id)) problems.push(`重复 id：${it.id}`);
    seen.add(it.id);
    const b = it.box;
    if (![b.x, b.y, b.z, b.w, b.h, b.d].every(Number.isFinite)) problems.push(`${it.id} 含非数值坐标`);
    if (b.w <= 0 || b.h <= 0 || b.d <= 0) problems.push(`${it.id} 尺寸非正`);
    if (b.y < scene.space.deskY - 1e-6) problems.push(`${it.id} 低于桌面`);
    if (b.x + b.w > scene.space.width + 1e-6 || b.z + b.d > scene.space.depth + 1e-6) {
      problems.push(`${it.id} 超出桌体`);
    }
  }
  for (const it of scene.items) {
    if (it.pluggedInto && !seen.has(it.pluggedInto)) problems.push(`${it.id} 引用不存在的插座`);
  }
  if (scene.space.width <= 0 || scene.space.depth <= 0) problems.push('桌体尺寸非正');
  return problems;
}

/** 兜底读取器：评测轨预设、展示轨手动录入的结构化现状都走这里。 */
export function structuredReader(scene: Scene, source: 'preset' | 'manual'): SceneReader {
  return {
    id: source,
    label: source === 'preset' ? '预设现状（评测轨 / 兜底）' : '手动录入结构化现状（兜底）',
    read: () => {
      const copy = structuredClone(scene);
      const notes = validateScene(copy);
      return {
        scene: copy,
        confidence: notes.length ? Math.max(0.35, 1 - notes.length * 0.15) : 1,
        source,
        notes,
      };
    },
  };
}

/* 阶段 4b 的照片轨只需再实现一个 SceneReader（read 里调视觉模型），
   编排、判分、局部性采集都不用改 —— 决策 4「只换最前面读现状那一个节点」。 */

/* ---------- 确定性意图路由：不接 AI，关键词决定归责到哪个节点 ---------- */

const NODE_HINTS: Record<string, string[]> = {
  anchor: ['显示器', '屏幕', '副屏', '笔记本', '插座', '供电', '走线', '格位', '层板', '书', '挂件', '抬高', '净空'],
  ergonomics: ['键盘', '鼠标', '伸手', '人机', '常用'],
  periphery: ['水杯', '台灯', '收纳', '绿植', '增高架', '周边'],
};

const ADD_WORDS: { word: string; kind: ItemKind }[] = [
  { word: '收纳盒', kind: 'storage' },
  { word: '绿植', kind: 'plant' },
  { word: '增高架', kind: 'riser' },
];

export interface RouteResult { nodeId: string; kinds: ItemKind[]; added: ItemKind[] }

export function routeInstruction(text: string, scene: Scene): RouteResult {
  const added: ItemKind[] = [];
  if (/加|添|新增|再来/.test(text)) {
    for (const a of ADD_WORDS) {
      if (text.includes(a.word) && !scene.items.some((i) => i.kind === a.kind)) added.push(a.kind);
    }
  }
  let nodeId = 'periphery';
  let best = 0;
  for (const g of GROUPS) {
    const hits = (NODE_HINTS[g.nodeId] ?? []).filter((w) => text.includes(w)).length;
    if (hits > best) { best = hits; nodeId = g.nodeId; }
  }
  if (added.length) nodeId = 'periphery';
  const present = new Set(scene.items.map((i) => i.kind));
  const base = GROUPS.find((g) => g.nodeId === nodeId)!.kinds;
  const kinds = [...new Set([...base.filter((k) => present.has(k)), ...added])];
  return { nodeId, kinds, added };
}

/** 可复现的演示指令；requires 让前端按当前现状过滤掉无物件可用的轮次。 */
export interface DemoInstruction { text: string; requires?: ItemKind; adds?: ItemKind }
export const DEMO_INSTRUCTIONS: DemoInstruction[] = [
  { text: '把水杯挪开，离电子设备远一点' },
  { text: '台灯靠左放' },
  { text: '再加个收纳盒', adds: 'storage' },
  { text: '键盘和鼠标靠前，方便伸手' },
  { text: '显示器往里推，给桌面留出空间' },
  { text: '把书挪到上层格位，给桌面腾地方', requires: 'book' },
];

export function availableInstructions(scene: Scene): DemoInstruction[] {
  const kinds = new Set(scene.items.map((i) => i.kind));
  return DEMO_INSTRUCTIONS.filter((d) =>
    (!d.requires || kinds.has(d.requires)) && (!d.adds || !kinds.has(d.adds)));
}

/* ---------- 跨轮次状态链 ---------- */

export interface EditTurn {
  index: number;
  instruction: string;
  nodeId: string;
  kinds: ItemKind[];
  before: Scene;
  after: Scene;
  changedIds: string[];
  upstreamTouched: string[];
  attempts: number;
  pass: boolean;
  codes: ViolationCode[];
  source: 'offline' | 'model' | 'error';
  note: string;
}

export interface EditSession {
  reader: SceneReader;
  read: ReadResult;
  initial: Scene;
  turns: EditTurn[];
}

export async function openSession(reader: SceneReader): Promise<EditSession> {
  const read = await reader.read();
  return { reader, read, initial: structuredClone(read.scene), turns: [] };
}

export function currentSceneOf(session: EditSession): Scene {
  return session.turns.length ? session.turns[session.turns.length - 1].after : session.initial;
}

function signature(it: BoxItem): string {
  const b = it.box;
  return [it.kind, b.x, b.y, b.z, b.w, b.h, b.d, it.pluggedInto ?? ''].join('|');
}

/** 新增、删除、位移、引用变化都算"这一块动了"。 */
export function diffScenes(a: Scene, b: Scene): string[] {
  const ma = new Map(a.items.map((i) => [i.id, signature(i)]));
  const mb = new Map(b.items.map((i) => [i.id, signature(i)]));
  const ids = new Set([...ma.keys(), ...mb.keys()]);
  return [...ids].filter((id) => ma.get(id) !== mb.get(id)).sort();
}

export interface TurnOptions {
  operator: Operator;
  options?: GradeOptions;
  maxAttempts?: number;
  strategy?: string;
}

/** 应用一轮增量指令：只重算归责节点，其余物件原样带入，然后采集局部性。 */
export async function applyTurn(
  session: EditSession, instruction: string, opts: TurnOptions,
): Promise<EditTurn> {
  const before = structuredClone(currentSceneOf(session));
  const route = routeInstruction(instruction, before);
  const gradeOptions = opts.options ?? DEFAULT_OPTIONS;
  const { kinds, nodeId } = route;
  const kept = before.items.filter((i) => !kinds.includes(i.kind));
  const maxAttempts = opts.maxAttempts ?? 3;

  let produced: BoxItem[] = [];
  let attempts = 0;
  let lastViolations: Violation[] = [];
  let source: EditTurn['source'] = 'offline';
  let note = '';

  if (!kinds.length) {
    note = '当前现状在该节点下没有可重算的物件，本轮为空操作。';
  } else {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      const req: PlacementRequest = {
        task: `多轮增量编辑第 ${session.turns.length + 1} 轮：${instruction}`,
        nodeId, kinds, space: before.space,
        existing: toExisting(kept, before.space),
        attempt,
        instruction,
        strategy: opts.strategy,
        violations: attempt > 1 ? lastViolations : undefined,
      };
      let res;
      try {
        res = await opts.operator(req);
      } catch (e) {
        source = 'error';
        note = `算子异常：${String(e)}`;
        break;
      }
      source = res.source === 'model' ? 'model' : res.source === 'error' ? 'error' : 'offline';
      if (res.error) { note = `算子返回错误：${res.error}`; break; }
      produced = res.placements
        .filter((p) => kinds.includes(p.id as ItemKind))
        .map((p) => makeItem(
          before.space, p.id, p.id as ItemKind, safeSurfaceId(before.space, p.surfaceId), p.x, p.z, p.lift,
        ));
      const focus = new Set(produced.map((i) => i.id));
      const violations = grade({ space: before.space, items: [...kept, ...produced] }, gradeOptions)
        .hard.filter((v) => v.objectIds.some((id) => focus.has(id)));
      if (!violations.length) break;
      lastViolations = violations;
    }
  }

  const after: Scene = { space: before.space, items: kinds.length ? [...kept, ...produced] : before.items };
  const changedIds = diffScenes(before, after);
  const allowed = new Set(kinds);
  const upstreamTouched = changedIds.filter((id) => {
    const it = after.items.find((x) => x.id === id) ?? before.items.find((x) => x.id === id);
    return !it || !allowed.has(it.kind);
  });
  const g = grade(after, gradeOptions);
  const turn: EditTurn = {
    index: session.turns.length + 1,
    instruction, nodeId, kinds,
    before, after, changedIds, upstreamTouched, attempts,
    pass: g.pass,
    codes: [...new Set(g.hard.map((v) => v.code))],
    source,
    note: note || (route.added.length
      ? `新增 ${route.added.join(',')}`
      : changedIds.length
        ? `重算 ${nodeId} 节点`
        : `重算 ${nodeId} 节点，但现状已满足该意图，未产生位移`),
  };
  session.turns.push(turn);
  return turn;
}

/* ---------- 局部性指标 ---------- */

export interface LocalityReport {
  turns: number;
  itemCount: number;
  changedTotal: number;
  upstreamTotal: number;
  maxChanged: number;
  avgChanged: number;
  avgRatio: number;
}

export function localityReport(session: EditSession): LocalityReport {
  const turns = session.turns.length;
  const itemCount = currentSceneOf(session).items.length;
  const changedTotal = session.turns.reduce((n, t) => n + t.changedIds.length, 0);
  const upstreamTotal = session.turns.reduce((n, t) => n + t.upstreamTouched.length, 0);
  const maxChanged = Math.max(0, ...session.turns.map((t) => t.changedIds.length));
  const avgChanged = turns ? changedTotal / turns : 0;
  return {
    turns, itemCount, changedTotal, upstreamTotal, maxChanged, avgChanged,
    avgRatio: turns && itemCount ? changedTotal / (turns * itemCount) : 0,
  };
}

export function localityLines(session: EditSession): string[] {
  const lines: string[] = [];
  lines.push('轮  指令                              节点        变化物件                上游  判分');
  for (const t of session.turns) {
    lines.push(
      `${String(t.index).padEnd(4)}${t.instruction.padEnd(32)}${t.nodeId.padEnd(12)}` +
      `${(t.changedIds.join(',') || '-').padEnd(24)}${String(t.upstreamTouched.length).padEnd(6)}` +
      `${t.pass ? 'PASS' : 'FAIL ' + t.codes.join(',')}`,
    );
  }
  const r = localityReport(session);
  lines.push('');
  lines.push(`合计 ${r.turns} 轮 · 场景 ${r.itemCount} 件 · 累计变化 ${r.changedTotal} 件次 · 上游触碰 ${r.upstreamTotal} 次`);
  lines.push(`平均每轮 ${r.avgChanged.toFixed(1)}/${r.itemCount} 件（${(r.avgRatio * 100).toFixed(1)}%）· 单轮最多 ${r.maxChanged} 件`);
  lines.push(`起点现状：${session.read.source} · 置信度 ${session.read.confidence.toFixed(2)}${session.read.notes.length ? ` · 校验问题 ${session.read.notes.length} 处` : ''}`);
  lines.push(`算子：${session.turns[0]?.source ?? 'offline'}；离线结果为确定性演示桩，不能作为模型能力数字。`);
  lines.push('注意：上游零触碰由编排结构保证（每轮只重算归责节点），指标用于验证该保证未被打破。');
  return lines;
}
