import { ITEM_HOME, ITEM_SIZE, LABEL, makeItem } from './catalog.ts';
import { DEFAULT_OPTIONS, grade } from './grade.ts';
import { localOf, surfaceById } from './space.ts';
import type { BoxItem, ItemKind, SpaceSpec, Surface, Violation, ViolationCode } from './types.ts';

export const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash-1017';

export interface ChatMessage { role: 'system' | 'user'; content: string }
export interface CompletionUsage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
export interface CompletionResponse {
  content: string;
  usage?: CompletionUsage;
  model?: string;
  error?: string;
}
export type CompletionCaller = (messages: ChatMessage[]) => Promise<CompletionResponse>;

/** 浏览器侧：只调本地代理，不接触 API key。 */
export function proxyCaller(): CompletionCaller {
  return async (messages) => {
    const res = await fetch('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || data.error) {
      return { content: '', error: data.error ? JSON.stringify(data.error) : `HTTP_${res.status}` };
    }
    const choices = data.choices as { message?: { content?: string } }[] | undefined;
    return {
      content: choices?.[0]?.message?.content ?? '',
      usage: data.usage as CompletionUsage | undefined,
      model: typeof data.model === 'string' ? data.model : undefined,
    };
  };
}

/** Node 评测脚本侧：直连 OpenRouter，key 由调用方从环境变量取。 */
export function directCaller(key: string, model: string): CompletionCaller {
  return async (messages) => {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:5173',
        'X-Title': 'dorm-desk-workflow',
      },
      body: JSON.stringify({
        model, messages,
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 1200,
      }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok || data.error) {
      return { content: '', error: data.error ? JSON.stringify(data.error) : `HTTP_${res.status}` };
    }
    const choices = data.choices as { message?: { content?: string } }[] | undefined;
    return {
      content: choices?.[0]?.message?.content ?? '',
      usage: data.usage as CompletionUsage | undefined,
      model: typeof data.model === 'string' ? data.model : undefined,
    };
  };
}

export interface ExistingItem {
  id: string;
  kind: ItemKind;
  /** 站在哪个放置面上 */
  surfaceId: string;
  /** 面内坐标 */
  x: number;
  z: number;
  /** 离该面的高度 */
  lift?: number;
}

export interface PlacementRequest {
  task: string;
  nodeId: string;
  kinds: ItemKind[];
  space: SpaceSpec;
  existing: ExistingItem[];
  attempt: number;
  violations?: Violation[];
  instruction?: string;
  strategy?: string;
}

export interface Placement { id: string; surfaceId: string; x: number; z: number; lift: number }

export interface OperatorResult {
  placements: Placement[];
  raw?: string;
  latencyMs: number;
  tokens: number;
  source: 'offline' | 'model' | 'error';
  model?: string;
  error?: string;
}

export type Operator = (req: PlacementRequest) => Promise<OperatorResult>;

/** 面 id 不存在时退到桌面；模型与离线算子共用，避免抛错。 */
export function safeSurfaceId(space: SpaceSpec, id: string): string {
  if (space.surfaces.some((s) => s.id === id)) return id;
  return space.surfaces.find((s) => s.kind === 'desk')?.id ?? space.surfaces[0].id;
}

/** 世界坐标 → 面内坐标；读现状后要回填给算子时用。 */
export function toExisting(items: BoxItem[], space: SpaceSpec): ExistingItem[] {
  return items.map((i) => {
    const surface = surfaceById(space, i.surfaceId);
    const local = surface
      ? localOf(surface, i.box)
      : { x: i.box.x, z: i.box.z, lift: i.box.y - space.deskY };
    return { id: i.id, kind: i.kind, surfaceId: i.surfaceId, ...local };
  });
}

/** 模型只负责给 surfaceId + 面内 x/z/lift；尺寸、层级、语义全部由本地 catalog 决定。 */
export function buildMessages(req: PlacementRequest): ChatMessage[] {
  const catalog = req.kinds.map((k) => ({
    id: k, label: LABEL[k], surface: ITEM_HOME[k].surface,
    w: ITEM_SIZE[k].w, h: ITEM_SIZE[k].h, d: ITEM_SIZE[k].d,
    defaultLift: ITEM_HOME[k].lift ?? 0,
  }));
  const surfaces = req.space.surfaces.map((s) => ({
    id: s.id, label: s.label, kind: s.kind, w: s.w, d: s.d, headroom: s.headroom,
  }));
  const system = [
    '你是宿舍桌面布局助手。只输出一个 JSON 对象，不要解释、不要 markdown 代码块。',
    '格式：{"placements":[{"id":"物件 id","surfaceId":"放置面 id","x":数字,"z":数字,"lift":数字}]}',
    `单位 cm。x 向右、z 向桌子里侧，都是所选放置面的面内坐标，原点在该面左下角；lift 是物件离该面的高度，通常为 0。`,
    `放置面（格位有独立的宽、深与层高 headroom）：${JSON.stringify(surfaces)}`,
    `桌面高 ${req.space.deskY}cm，床板底 ${req.space.bedBottom}cm。`,
    '硬约束：物件之间不能立体重叠，也不能插进柜体侧板/层板/背板；物件必须完整落在所属面内；',
    '物件高度不能超过该面 headroom（格位层高）；屏幕上方到床板或上层物件至少 25cm；',
    '水杯离电子设备至少 15cm；键盘、鼠标、水杯、笔记本等常用件要落在坐姿伸手范围内（桌面近侧或最下层格位）；',
    '需供电物件离插座不超过 55cm；屏幕前方不能有高物件挡住视线；单个格位的投影占用不能超过 85%。',
    '只输出本次要求的物件，id 必须原样使用；尺寸由程序决定，不要输出尺寸。',
  ].join('\n');
  const user = [
    `任务：${req.task}`,
    `当前节点：${req.nodeId}，需要放置：${JSON.stringify(catalog)}`,
    `已有物件（不要与之重叠；surfaceId 与面内坐标可直接沿用）：${JSON.stringify(req.existing)}`,
    req.violations?.length
      ? `上一次尝试被判分器拒绝：${JSON.stringify(req.violations.map((v) => ({ code: v.code, ids: v.objectIds, message: v.message })))}。请只修正这些物件的位置，其余保持不动。`
      : '',
    req.instruction ? `用户追加要求：${req.instruction}` : '',
    req.strategy ? `用户选择的冲突解决策略：${req.strategy}` : '',
    `这是第 ${req.attempt} 次尝试。`,
  ].filter(Boolean).join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

export function parsePlacements(raw: string, kinds: ItemKind[], space: SpaceSpec): Placement[] {
  const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('响应中没有 JSON 对象');
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  const arr = Array.isArray(parsed) ? parsed : (parsed as { placements?: unknown }).placements;
  if (!Array.isArray(arr)) throw new Error('响应缺少 placements 数组');
  const allowed = new Set<string>(kinds);
  const seen = new Set<string>();
  const out: Placement[] = [];
  for (const p of arr as Record<string, unknown>[]) {
    const id = String(p.id ?? '');
    if (!allowed.has(id) || seen.has(id)) continue;
    const kind = id as ItemKind;
    const x = Number(p.x);
    const z = Number(p.z);
    const lift = p.lift === undefined ? 0 : Number(p.lift);
    if (![x, z, lift].every(Number.isFinite)) continue;
    const surfaceId = typeof p.surfaceId === 'string'
      ? safeSurfaceId(space, p.surfaceId)
      : safeSurfaceId(space, ITEM_HOME[kind]?.surface ?? 'desk');
    seen.add(id);
    out.push({ id, surfaceId, x: Math.round(x), z: Math.round(z), lift: Math.round(lift) });
  }
  return out;
}

export function createModelOperator(call: CompletionCaller): Operator {
  return async (req) => {
    const t0 = performance.now();
    try {
      const res = await call(buildMessages(req));
      if (res.error) {
        return { placements: [], latencyMs: performance.now() - t0, tokens: 0, source: 'error', error: res.error };
      }
      return {
        placements: parsePlacements(res.content, req.kinds, req.space),
        raw: res.content,
        latencyMs: performance.now() - t0,
        tokens: res.usage?.total_tokens ?? 0,
        source: 'model',
        model: res.model,
      };
    } catch (e) {
      return { placements: [], latencyMs: performance.now() - t0, tokens: 0, source: 'error', error: String(e) };
    }
  };
}

/** 候选阶段由判分器裁决几何；走线只在插座已存在时纳入。 */
const GEOMETRY_CODES = new Set<ViolationCode>([
  'bounds', 'overlap', 'clearance', 'reach', 'occlusion', 'liquid', 'dangling',
  'penetration', 'capacity',
]);

type Bias = 'left' | 'right' | 'front' | 'back' | null;
interface Spot { surfaceId: string; x: number; z: number; lift: number }
interface Preference { bias: Bias; extraLift: number; up: boolean }

/** 展示轨的节点级改输入与冲突仲裁只改候选顺序，不改判分阈值。 */
function preference(req: PlacementRequest): Preference {
  const text = `${req.instruction ?? ''} ${req.strategy ?? ''}`;
  const bias: Bias = /靠左|左侧|左边/.test(text) ? 'left'
    : /靠右|右侧|右边/.test(text) ? 'right'
      : /靠前|前方|外沿|伸手/.test(text) ? 'front'
        : /靠里|里侧|贴墙|显示器|格位/.test(text) ? 'back'
          : null;
  return {
    bias,
    extraLift: /抬高|净空|上层|高层/.test(text) ? 15 : 0,
    up: /抬高|上层|高层|上一层/.test(text),
  };
}

function clampSpot(n: number, max: number): number {
  return Math.max(0, Math.min(Math.round(n), max));
}

/**
 * 物件可以站的面：默认归宿面优先，其次桌面（便于就近找回），最后其余格位。
 * 用户说"挪到上层"时，格位按高度从高到低排到最前——这是换放置面，不是换坐标。
 */
function candidateSurfaces(space: SpaceSpec, kind: ItemKind, pref: Preference): Surface[] {
  const home = ITEM_HOME[kind].surface;
  const homeSurface = space.surfaces.find((s) => s.id === home);
  const primary = homeSurface ? [homeSurface] : [];
  const desk = space.surfaces.filter((s) => s.kind === 'desk' && s.id !== home);
  const slots = space.surfaces.filter((s) => s.kind === 'slot' && s.id !== home);
  if (pref.up && homeSurface?.kind === 'slot') {
    return [...slots.sort((a, b) => b.origin.y - a.origin.y), ...primary];
  }
  return [...primary, ...desk, ...slots];
}

/** 确定性候选：先试默认归宿面内的偏移，再退化为该面网格扫描，面与面之间按上面的顺序。 */
function candidateSpots(req: PlacementRequest, kind: ItemKind, pref: Preference): Spot[] {
  const size = ITEM_SIZE[kind];
  const home = ITEM_HOME[kind];
  const xs = pref.bias === 'left' ? [0, -8, -16, -24, -32, -40, 8, 16, 24, 32, 40]
    : pref.bias === 'right' ? [0, 8, 16, 24, 32, 40, -8, -16, -24, -32, -40]
      : [0, -8, 8, -16, 16, -24, 24, -32, 32, -40, 40];
  const zs = pref.bias === 'front' ? [0, -6, -12, -18, -24, 6, 12, 18, 24]
    : pref.bias === 'back' ? [0, 6, 12, 18, 24, -6, -12, -18, -24]
      : [0, -6, 6, -12, 12, -18, 18, -24, 24];

  const spots: Spot[] = [];
  for (const surface of candidateSurfaces(req.space, kind, pref)) {
    const maxX = Math.max(0, surface.w - size.w);
    const maxZ = Math.max(0, surface.d - size.d);
    const vertical = surface.plane === 'vertical';
    const lift = (home.lift ?? 0) + (vertical ? pref.extraLift : 0);
    const baseX = clampSpot(home.x, maxX);
    const baseZ = vertical ? 0 : clampSpot(home.z, maxZ);
    const push = (x: number, z: number): void => {
      spots.push({ surfaceId: surface.id, x: clampSpot(x, maxX), z: clampSpot(z, maxZ), lift });
    };
    for (const dz of zs) for (const dx of xs) push(baseX + dx, baseZ + dz);
    for (let z = 0; z <= maxZ; z += 6) {
      for (let x = 0; x <= maxX; x += 6) push(x, z);
    }
  }

  /** 用户明确改了意图时，不能原样吐回默认槽位；非原位候选优先，原位只作兜底。 */
  const hasIntent = !!req.instruction || !!req.strategy;
  const baseSpot = spots[0];
  const sameAsBase = (s: Spot): boolean =>
    s.surfaceId === baseSpot.surfaceId && s.x === baseSpot.x && s.z === baseSpot.z;
  const ordered = hasIntent
    ? [...spots.filter((s) => !sameAsBase(s)), baseSpot]
    : spots;
  const skip = req.attempt > 1 && !pref.bias ? Math.min((req.attempt - 1) * 2, 20) : 0;
  return ordered.slice(skip);
}

/** 还原已有物件；重算时剔除本组旧位置，避免和自己比较。 */
function placedItems(req: PlacementRequest): BoxItem[] {
  const redoing = new Set<string>(req.kinds);
  return req.existing
    .filter((e) => !redoing.has(e.id))
    .map((e) => makeItem(req.space, e.id, e.kind, safeSurfaceId(req.space, e.surfaceId), e.x, e.z, e.lift ?? 0));
}

/** 只拒绝与本次新增物件相关的几何违规；allowLiquid 用于故意制造一次水杯冲突。 */
function fits(
  req: PlacementRequest, placed: BoxItem[], kind: ItemKind, spot: Spot, allowLiquid: boolean,
): boolean {
  const item = makeItem(req.space, kind, kind, safeSurfaceId(req.space, spot.surfaceId), spot.x, spot.z, spot.lift);
  const items = [...placed, item];
  const hard = grade({ space: req.space, items }, DEFAULT_OPTIONS).hard;
  const hasStrip = items.some((i) => i.kind === 'powerstrip');
  for (const h of hard) {
    if (h.code === 'cable') {
      if (hasStrip && (kind === 'powerstrip' || h.objectIds.includes(kind))) return false;
      continue;
    }
    if (h.code === 'liquid' && allowLiquid && h.objectIds.includes(kind)) continue;
    if (h.objectIds.includes(kind) && GEOMETRY_CODES.has(h.code)) return false;
  }
  return true;
}

/** wantBad 时挑"唯一违规就是水杯安全距离"的点，其余情况挑全合规点。 */
function findMugSpot(
  req: PlacementRequest, placed: BoxItem[], pref: Preference, wantBad: boolean,
): Spot | null {
  for (const spot of candidateSpots(req, 'mug', pref)) {
    if (!fits(req, placed, 'mug', spot, true)) continue;
    const clean = fits(req, placed, 'mug', spot, false);
    if (wantBad ? !clean : clean) return spot;
  }
  return null;
}

/**
 * 无 key 时的确定性降级算子：用同一个解析式判分器挑合规坐标，
 * 首次尝试只故意留一处 liquid 违规。端到端没有重算机会所以失败，
 * 工作流收到判分反馈后只重算那个节点。两臂是同一个算子，
 * 差异完全来自编排，不是"模型变聪明了"。
 * 这一路产出的任何数字都只是演示桩，不能当简历数据。
 */
export const offlineOperator: Operator = async (req) => {
  const t0 = performance.now();
  const placed = placedItems(req);
  const pref = preference(req);
  const blamed = new Set(req.violations?.flatMap((v) => v.objectIds) ?? []);
  const fixMug = blamed.has('mug') ||
    (req.strategy ?? '').includes('水杯') || (req.instruction ?? '').includes('水杯');
  const injectBadMug = req.attempt === 1 && !req.violations?.length &&
    !req.instruction && !req.strategy;

  const placements: Placement[] = [];
  for (const kind of req.kinds) {
    let spot: Spot | null = null;
    if (kind === 'mug' && (injectBadMug || fixMug)) {
      spot = findMugSpot(req, placed, pref, injectBadMug && !fixMug);
    }
    if (!spot) {
      spot = candidateSpots(req, kind, pref).find((s) => fits(req, placed, kind, s, false)) ?? {
        surfaceId: safeSurfaceId(req.space, ITEM_HOME[kind].surface),
        x: 0, z: 0, lift: ITEM_HOME[kind].lift ?? 0,
      };
    }
    placed.push(makeItem(req.space, kind, kind, spot.surfaceId, spot.x, spot.z, spot.lift));
    placements.push({ id: kind, surfaceId: spot.surfaceId, x: spot.x, z: spot.z, lift: spot.lift });
  }
  return { placements, latencyMs: performance.now() - t0, tokens: 0, source: 'offline' };
};
