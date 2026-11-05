import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * 生成 5 件核心低模资产（monitor / laptop / keyboard / mug / lamp）。
 *
 * 为什么用脚本而不是放现成 glb：尺寸必须严格落在 `ITEM_SIZE` 的判分盒体里，
 * 原点必须在底面中心，正面必须朝 +Z。手搓模型很难稳定满足，脚本一次写清、
 * 改尺寸重跑即可，也就不需要一个不可编辑的二进制黑盒。
 *
 * 网格名决定材质（见 src/assets/manifest.ts 的 TONE_BY_PREFIX）：
 *   screen_* → 屏幕深色   metal_* → 金属灰   accent_* → 深色配件   body_* → 主体浅色
 */

const DEG = Math.PI / 180;
const V = (x, y, z) => ({ x, y, z });
const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
const cross = (a, b) => V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (a) => {
  const len = Math.hypot(a.x, a.y, a.z) || 1;
  return V(a.x / len, a.y / len, a.z / len);
};

/** 一个部件：一堆三角形 + 顶点法线，名字前缀决定材质。 */
class Part {
  constructor(name) {
    this.name = name;
    this.pos = [];
    this.nrm = [];
  }

  tri(a, b, c) {
    const n = norm(cross(sub(b, a), sub(c, a)));
    for (const p of [a, b, c]) {
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(n.x, n.y, n.z);
    }
  }

  /** hint 是期望的朝外方向，绕反了就翻回来，省得手推缠绕顺序。 */
  quad(a, b, c, d, hint) {
    if (dot(cross(sub(b, a), sub(c, a)), hint) < 0) [b, d] = [d, b];
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  triOriented(a, b, c, hint) {
    if (dot(cross(sub(b, a), sub(c, a)), hint) < 0) [b, c] = [c, b];
    this.tri(a, b, c);
  }

  box(w, h, d, cx, cy, cz = 0) {
    const x0 = cx - w / 2, x1 = cx + w / 2;
    const y0 = cy - h / 2, y1 = cy + h / 2;
    const z0 = cz - d / 2, z1 = cz + d / 2;
    const p = [
      V(x0, y0, z0), V(x1, y0, z0), V(x1, y1, z0), V(x0, y1, z0),
      V(x0, y0, z1), V(x1, y0, z1), V(x1, y1, z1), V(x0, y1, z1),
    ];
    this.quad(p[4], p[5], p[6], p[7], V(0, 0, 1));
    this.quad(p[1], p[0], p[3], p[2], V(0, 0, -1));
    this.quad(p[0], p[4], p[7], p[3], V(-1, 0, 0));
    this.quad(p[5], p[1], p[2], p[6], V(1, 0, 0));
    this.quad(p[3], p[7], p[6], p[2], V(0, 1, 0));
    this.quad(p[0], p[1], p[5], p[4], V(0, -1, 0));
  }

  cylinder(rTop, rBot, h, seg, cx, cy, cz = 0) {
    const y0 = cy, y1 = cy + h;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const mid = (a0 + a1) / 2;
      const hint = V(Math.cos(mid), 0, Math.sin(mid));
      const b0 = V(cx + Math.cos(a0) * rBot, y0, cz + Math.sin(a0) * rBot);
      const b1 = V(cx + Math.cos(a1) * rBot, y0, cz + Math.sin(a1) * rBot);
      const t0 = V(cx + Math.cos(a0) * rTop, y1, cz + Math.sin(a0) * rTop);
      const t1 = V(cx + Math.cos(a1) * rTop, y1, cz + Math.sin(a1) * rTop);
      this.quad(b0, t0, t1, b1, hint);
      if (rTop > 0) this.triOriented(V(cx, y1, cz), t0, t1, V(0, 1, 0));
      if (rBot > 0) this.triOriented(V(cx, y0, cz), b0, b1, V(0, -1, 0));
    }
  }

  /** XY 平面上的圆环，用来做杯把。 */
  torus(major, minor, segU, segV, cx, cy, cz = 0) {
    const at = (u, v) => {
      const cu = Math.cos(u), su = Math.sin(u);
      const cv = Math.cos(v), sv = Math.sin(v);
      return V(
        cx + (major + minor * cv) * cu,
        cy + (major + minor * cv) * su,
        cz + minor * sv,
      );
    };
    for (let i = 0; i < segU; i++) {
      for (let j = 0; j < segV; j++) {
        const u0 = (i / segU) * Math.PI * 2, u1 = ((i + 1) / segU) * Math.PI * 2;
        const v0 = (j / segV) * Math.PI * 2, v1 = ((j + 1) / segV) * Math.PI * 2;
        const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2;
        const hint = V(Math.cos(mv) * Math.cos(mu), Math.cos(mv) * Math.sin(mu), Math.sin(mv));
        this.quad(at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1), hint);
      }
    }
  }

  /** 绕 X 轴旋转，pivot 用 (y, z) 指定（笔记本屏轴就靠它）；法线只转不平移。 */
  rotateX(deg, py, pz) {
    const a = deg * DEG;
    const cos = Math.cos(a), sin = Math.sin(a);
    for (let i = 0; i < this.pos.length; i += 3) {
      const dy = this.pos[i + 1] - py;
      const dz = this.pos[i + 2] - pz;
      this.pos[i + 1] = py + dy * cos - dz * sin;
      this.pos[i + 2] = pz + dy * sin + dz * cos;

      const ny = this.nrm[i + 1];
      const nz = this.nrm[i + 2];
      this.nrm[i + 1] = ny * cos - nz * sin;
      this.nrm[i + 2] = ny * sin + nz * cos;
    }
    return this;
  }

  bounds() {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], this.pos[i + k]);
        max[k] = Math.max(max[k], this.pos[i + k]);
      }
    }
    return { min, max };
  }
}

function pad4(buf, fill) {
  const rest = (4 - (buf.length % 4)) % 4;
  return rest ? Buffer.concat([buf, Buffer.alloc(rest, fill)]) : buf;
}

function buildGlb(parts) {
  const chunks = [];
  const bufferViews = [];
  const accessors = [];
  const meshes = [];
  const nodes = [];
  let offset = 0;

  const pushView = (buf) => {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      offset += pad;
    }
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target: 34962 });
    chunks.push(buf);
    offset += buf.length;
    return bufferViews.length - 1;
  };

  parts.forEach((part, index) => {
    const pos = new Float32Array(part.pos);
    const nrm = new Float32Array(part.nrm);
    const { min, max } = part.bounds();

    const posView = pushView(Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength));
    const nrmView = pushView(Buffer.from(nrm.buffer, nrm.byteOffset, nrm.byteLength));

    const posAcc = accessors.push({
      bufferView: posView, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max,
    }) - 1;
    const nrmAcc = accessors.push({
      bufferView: nrmView, componentType: 5126, count: nrm.length / 3, type: 'VEC3',
    }) - 1;

    meshes.push({
      name: part.name,
      primitives: [{ attributes: { POSITION: posAcc, NORMAL: nrmAcc }, mode: 4 }],
    });
    nodes.push({ mesh: index, name: part.name });
  });

  const binChunk = pad4(Buffer.concat(chunks), 0);
  const json = {
    asset: { version: '2.0', generator: 'dorm-desk-workflow/tools/make-models.mjs' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binChunk.length }],
  };
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);

  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
}

/* ---------------- 5 件资产（尺寸对照 catalog.ts 的 ITEM_SIZE） ---------------- */

/**
 * 底座 + 立柱 + 面板 + 内嵌屏幕；主副屏共用同一套做法，只换尺寸。
 * 屏幕朝 −Z：用户坐在 z 小的一侧，键鼠也在那一侧。
 */
function monitor(w, h) {
  const panelW = w - 4;
  const panelH = h - 11;
  const panelY = 9 + panelH / 2;

  const stand = new Part('metal_stand');
  stand.box(24, 1.6, 15, 0, 0.8, 1);
  stand.box(4.4, 9, 3.6, 0, 6.1, -2);

  const panel = new Part('body_shell');
  panel.box(panelW, panelH, 3.2, 0, panelY, -4.2);

  const screen = new Part('screen_panel');
  screen.box(panelW - 3.4, panelH - 3.6, 0.5, 0, panelY, -5.85);

  return [stand, panel, screen];
}

/** 32×25×22：机身 + 键位 + 后仰屏盖 + 内嵌屏幕 */
function laptop() {
  const base = new Part('body_shell');
  base.box(30, 1.8, 18, 0, 0.9, -2);

  const deck = new Part('accent_deck');
  deck.box(26, 0.25, 11, 0, 1.92, -2.5);

  const lid = new Part('body_lid');
  lid.box(30, 17, 0.9, 0, 9.5, -2 + 9);
  lid.rotateX(12, 1.8, -2 + 9);

  const screen = new Part('screen_panel');
  screen.box(26.6, 13.6, 0.4, 0, 9.5, -2 + 9 - 0.65);
  screen.rotateX(12, 1.8, -2 + 9);

  return [base, deck, lid, screen];
}

/** 44×3×15：薄机身 + 键区 + 三排键槽 */
function keyboard() {
  const shell = new Part('body_shell');
  shell.box(42, 1.4, 14, 0, 0.7, 0);

  const keys = new Part('accent_keys');
  keys.box(40, 0.4, 12, 0, 1.6, 0);
  for (const z of [-3.9, 0, 3.9]) keys.box(36, 0.3, 2.6, 0, 1.9, z);

  return [shell, keys];
}

/** 9×10×9：锥形杯身 + 杯口 + 杯把 */
function mug() {
  const body = new Part('body_shell');
  body.cylinder(3.35, 3.1, 8.4, 18, 0, 0);

  const rim = new Part('accent_rim');
  rim.cylinder(2.9, 2.9, 0.25, 18, 0, 8.4);

  const handle = new Part('body_handle');
  handle.torus(1.3, 0.42, 14, 7, 3.1, 4.6);

  return [body, rim, handle];
}

/** 14×35×14：底盘 + 灯杆 + 下大上小的灯罩 */
function lamp() {
  const base = new Part('body_base');
  base.cylinder(5.0, 5.4, 1.6, 20, 0, 0);

  const stem = new Part('metal_stem');
  stem.cylinder(0.65, 0.75, 22, 10, 0, 1.6);

  const shade = new Part('accent_shade');
  shade.cylinder(3.0, 5.0, 6.5, 16, 0, 23.6);

  return [base, stem, shade];
}

/** 7×3×11：三段渐窄的矮机身，读作鼠标 */
function mouse() {
  const body = new Part('body_shell');
  body.box(6.4, 1.2, 10.4, 0, 0.6, 0);
  body.box(5.8, 1.0, 9.0, 0, 1.6, -0.4);
  body.box(4.4, 0.7, 7.0, 0, 2.35, -0.9);

  const accent = new Part('accent_buttons');
  accent.box(2.4, 0.2, 2.6, 0, 2.7, -1.0);

  return [body, accent];
}

/** 25×3×6：底壳 + 面板 + 四个插孔 + 出线口 */
function powerstrip() {
  const body = new Part('body_shell');
  body.box(24, 2.0, 5.4, 0, 1.0, 0);
  body.box(1.4, 1.2, 1.4, -11.5, 1.0, 0);

  const panel = new Part('accent_panel');
  panel.box(23, 0.5, 4.6, 0, 2.0, 0);
  for (const x of [-7.5, -2.5, 2.5, 7.5]) panel.box(3.2, 0.25, 2.8, x, 2.22, 0);

  return [body, panel];
}

/** 20×12×16：箱体 + 盖子 + 前面板抠手 */
function storage() {
  const body = new Part('body_shell');
  body.box(19, 11, 15, 0, 5.5, 0);

  const accent = new Part('accent_lid');
  accent.box(19.6, 1.4, 15.6, 0, 11.0, 0);
  accent.box(6, 1.6, 0.6, 0, 7.5, -7.6);

  return [body, accent];
}

/** 12×18×12：花盆 + 土面 + 几片尖叶 */
function plant() {
  const pot = new Part('body_pot');
  pot.cylinder(5.0, 4.2, 6, 16, 0, 0);

  const soil = new Part('accent_soil');
  soil.cylinder(4.6, 4.6, 0.3, 16, 0, 5.7);

  const leaves = new Part('body_leaves');
  const blades = [
    [0, 0, 10.5], [2.0, 1.2, 8.6], [-2.2, 0.8, 9.2], [1.0, -1.8, 7.8], [-1.4, -1.6, 8.2],
  ];
  for (const [x, z, h] of blades) leaves.cylinder(0.15, 0.9, h, 6, x, 6, z);

  return [pot, soil, leaves];
}

/** 20×15×2：顶板 + 两侧立轨 + 横杆 + 三个挂勾，全部朝 −Z 伸出，整体贴 y=0 起 */
function hanger() {
  const plate = new Part('body_plate');
  plate.box(18, 4, 0.6, 0, 12, -0.3);
  plate.box(1.2, 12, 0.6, -8.4, 6, -0.3);
  plate.box(1.2, 12, 0.6, 8.4, 6, -0.3);

  const metal = new Part('metal_rail');
  metal.box(17, 1.2, 1.2, 0, 8.2, -0.6);
  for (const x of [-6, 0, 6]) metal.box(0.8, 3.2, 1.4, x, 6, -0.7);

  return [plate, metal];
}

/** 60×8×20：一层台面板 + 两条腿 + 背挡，显示器压在上面 */
function riser() {
  const top = new Part('body_shell');
  top.box(58, 2.2, 19, 0, 5.9, 0);

  const metal = new Part('metal_legs');
  metal.box(3.2, 6.0, 17, -26, 3.0, 0);
  metal.box(3.2, 6.0, 17, 26, 3.0, 0);
  metal.box(58, 2.0, 1.2, 0, 4.2, 8.4);

  return [top, metal];
}

/** 18×10×24：三本错开叠放的书，深浅交替才看得出是三本 */
function book() {
  const a = new Part('body_shell');
  a.box(16, 2.6, 22, 0, 1.3, -0.5);
  a.box(14.4, 2.8, 20, -0.4, 6.5, -0.3);

  const b = new Part('accent_spine');
  b.box(15, 2.4, 21, 0.6, 3.9, -0.9);

  return [a, b];
}

const MODELS = {
  monitor: { parts: () => monitor(54, 34), hull: [54, 34, 18] },
  second_monitor: { parts: () => monitor(48, 32), hull: [48, 32, 18] },
  laptop: { parts: laptop, hull: [32, 25, 22] },
  keyboard: { parts: keyboard, hull: [44, 3, 15] },
  mouse: { parts: mouse, hull: [7, 3, 11] },
  mug: { parts: mug, hull: [9, 10, 9] },
  lamp: { parts: lamp, hull: [14, 35, 14] },
  powerstrip: { parts: powerstrip, hull: [25, 3, 6] },
  storage: { parts: storage, hull: [20, 12, 16] },
  plant: { parts: plant, hull: [12, 18, 12] },
  hanger: { parts: hanger, hull: [20, 15, 2] },
  riser: { parts: riser, hull: [60, 8, 20] },
  book: { parts: book, hull: [18, 10, 24] },
};

mkdirSync('public/models', { recursive: true });

for (const [kind, { parts, hull }] of Object.entries(MODELS)) {
  const built = parts();
  const glb = buildGlb(built);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let tris = 0;
  for (const part of built) {
    tris += part.pos.length / 9;
    const b = part.bounds();
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], b.min[k]);
      max[k] = Math.max(max[k], b.max[k]);
    }
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const over = size.map((s, k) => (s > hull[k] + 0.5 ? `${s.toFixed(1)}>${hull[k]}` : '')).filter(Boolean);
  const flags = [
    Math.abs(min[1]) > 0.05 ? `底面未贴 y=0（${min[1].toFixed(2)}）` : '',
    /** 视觉重心可以偏（杯把、后仰屏），loader 会按包围盒重新归位；偏太多才是设计错。 */
    Math.abs((min[0] + max[0]) / 2) > 1.5 || Math.abs((min[2] + max[2]) / 2) > 1.5 ? 'x/z 偏离过大' : '',
    ...over,
  ].filter(Boolean);

  writeFileSync(`public/models/${kind}.glb`, glb);
  console.log(
    `${kind.padEnd(9)} ${String(glb.length).padStart(5)} B · ${String(tris).padStart(3)} 面 · ` +
    `尺寸 ${size.map((s) => s.toFixed(1)).join('×')} / 盒体 ${hull.join('×')}` +
    (flags.length ? ` · ${flags.join('，')}` : ' · 契约 OK'),
  );
}
