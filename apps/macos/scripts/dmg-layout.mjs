// What the Bogen disk image looks like when it opens, as data and bytes. Plain Node, no dependencies, no macOS tools:
// make-dmg.mjs uses it on a Mac, verify-dmg.mjs reads a built image back with it, and test/dmg-layout.test.ts checks
// it anywhere.
//
// The window is laid out without scripting Finder: the .DS_Store Finder reads is written directly, the same records
// Finder writes itself (window bounds without toolbar or sidebar, an icon view with a picture background, one icon
// position per item), so the layout is the same on every build and needs no Automation permission or GUI session.
// The background picture is referenced the way Finder references it, by an alias record built from the mounted
// volume's real file IDs, names and dates (see aliasRecord).
//
// Formats, as documented by their reverse-engineering (Mark Mentovai, Wim Lewis; the ds_store and mac_alias projects)
// and as Finder writes them:
//   .DS_Store   a "Bud1" buddy-allocated file holding one B-tree ("DSDB") of records (name, code, type, value)
//   bplist00    Apple's binary property list, for the window (bwsp) and icon view (icvp) settings
//   alias v2    the classic Alias Manager record Finder keeps for a background picture

export const BACKGROUND_SIZE = { width: 660, height: 400 };
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,30})?$/;

/**
 * The image's names and layout. Every name that reaches hdiutil, the file system or Finder comes from here and is
 * checked: a version that is not plain semver, or a volume name longer than HFS+ keeps in an alias, is refused.
 */
export function dmgPlan({ version, arch, release, productName = 'Bogen' }) {
  if (!VERSION.test(String(version))) throw new Error(`Not a version for a disk image name: ${JSON.stringify(version)}`);
  if (!['arm64', 'x64'].includes(arch)) throw new Error(`Not an architecture: ${JSON.stringify(arch)}`);
  if (!/^[A-Za-z][A-Za-z0-9 ]{0,15}$/.test(productName)) throw new Error(`Not a product name for a disk image: ${JSON.stringify(productName)}`);
  const volumeName = release ? `${productName} ${version}` : `${productName} ${version} Dev`;
  // An alias stores the volume name as a Pascal string of at most 27 bytes.
  if (Buffer.byteLength(volumeName, 'latin1') > 27) throw new Error(`Volume name too long for Finder's alias record (27 bytes): ${volumeName}`);
  const app = `${productName}.app`;
  return {
    productName,
    app,
    volumeName,
    fileName: release ? `${productName}-${version}-${arch}.dmg` : `${productName}-${version}-${arch}-dev-unsigned.dmg`,
    release: Boolean(release),
    window: { x: 200, y: 120, ...BACKGROUND_SIZE },
    iconSize: 128,
    textSize: 13,
    /** Icon centres in the window, in points from its top left. */
    items: [{ name: app, x: 180, y: 200 }, { name: 'Applications', x: 480, y: 200 }],
    background: '.background/background.tiff',
    volumeIcon: '.VolumeIcon.icns',
    /** Everything at the top of the volume: what verify-dmg.mjs accepts, besides what macOS adds when it mounts. */
    entries: [app, 'Applications', '.background', '.VolumeIcon.icns', '.DS_Store'],
    words: backgroundWords(Boolean(release), productName),
  };
}

/** The words in the window. English, like the rest of the Mac app's packaging. */
export function backgroundWords(release, productName = 'Bogen') {
  return {
    title: `Install ${productName}`,
    action: `Drag ${productName} onto Applications`,
    note: release
      ? [`Then open ${productName} from your Applications folder.`, 'Updating keeps your designs and settings.']
      : ['Development build, ad-hoc signed, for Macs you control. If macOS blocks the first open,', 'choose Open Anyway in System Settings › Privacy & Security.'],
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The background picture as SVG, at 1× (make-dmg renders it at 1× and 2× and joins both into one TIFF). Finder draws
 * the icons and their names on top; in Dark Mode it draws the names in white, so each name sits on a mid-grey plate
 * that keeps black and white text readable.
 */
export function backgroundSvg(plan) {
  const { width, height } = BACKGROUND_SIZE;
  const [a, b] = plan.items;
  const labelY = a.y + plan.iconSize / 2 + 14;
  const plate = (x) => `<rect x="${x - 62}" y="${labelY - 2}" width="124" height="22" rx="11" fill="#75727a" opacity="0.92"/>`;
  const font = `-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif`;
  const note = plan.words.note.map((line, i) => `<text x="${width / 2}" y="${350 + i * 18}" text-anchor="middle" font-size="12" fill="${plan.release ? '#55525a' : '#7a3b00'}">${esc(line)}</text>`).join('');
  const from = a.x + plan.iconSize / 2 + 18;
  const to = b.x - plan.iconSize / 2 - 18;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${esc(font)}">`,
    '<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbf9f5"/><stop offset="1" stop-color="#efebe3"/></linearGradient></defs>',
    `<rect width="${width}" height="${height}" fill="url(#bg)"/>`,
    `<rect x="0" y="0" width="${width}" height="4" fill="#2b3df2"/>`,
    `<text x="${width / 2}" y="54" text-anchor="middle" font-size="22" font-weight="600" fill="#1d1b20">${esc(plan.words.title)}</text>`,
    `<text x="${width / 2}" y="80" text-anchor="middle" font-size="13" fill="#55525a">${esc(plan.words.action)}</text>`,
    `<path d="M${from} ${a.y} C ${from + 40} ${a.y - 26}, ${to - 40} ${a.y - 26}, ${to} ${a.y}" fill="none" stroke="#2b3df2" stroke-width="5" stroke-linecap="round"/>`,
    `<path d="M${to - 16} ${a.y - 14} L ${to + 2} ${a.y + 1} L ${to - 20} ${a.y + 8}" fill="none" stroke="#2b3df2" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`,
    plate(a.x),
    plate(b.x),
    plan.release ? '' : `<rect x="${width / 2 - 230}" y="331" width="460" height="46" rx="10" fill="#fff4e5" stroke="#f0c48a"/>`,
    note,
    '</svg>',
  ].join('');
}

// ---------------------------------------------------------------- binary property lists (bplist00)

/** A value for bplist(): plain JS, with `{ real: n }` for a floating-point number and Buffers for data. */
export function bplist(root) {
  const objects = [];
  const encode = (v) => {
    const index = objects.length;
    objects.push(null);
    let bytes;
    if (v === false || v === true) bytes = Buffer.from([v ? 0x09 : 0x08]);
    else if (Buffer.isBuffer(v)) bytes = Buffer.concat([marker(0x40, v.length), v]);
    else if (typeof v === 'number' && Number.isInteger(v)) bytes = int(v);
    else if (v && typeof v === 'object' && 'real' in v) {
      bytes = Buffer.alloc(9);
      bytes[0] = 0x23;
      bytes.writeDoubleBE(v.real, 1);
    } else if (typeof v === 'string') {
      bytes = /^[\x00-\x7f]*$/.test(v) ? Buffer.concat([marker(0x50, v.length), Buffer.from(v, 'ascii')]) : Buffer.concat([marker(0x60, v.length), utf16be(v)]);
    } else if (Array.isArray(v)) {
      const refs = v.map(encode);
      bytes = Buffer.concat([marker(0xa0, refs.length), refs16(refs)]);
    } else if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      const k = keys.map(encode);
      const vals = keys.map((key) => encode(v[key]));
      bytes = Buffer.concat([marker(0xd0, keys.length), refs16(k), refs16(vals)]);
    } else throw new Error(`bplist: cannot encode ${typeof v}`);
    objects[index] = bytes;
    return index;
  };
  encode(root);
  if (objects.length > 0xffff) throw new Error('bplist: too many objects');
  const head = Buffer.from('bplist00', 'ascii');
  const offsets = [];
  let at = head.length;
  for (const o of objects) {
    offsets.push(at);
    at += o.length;
  }
  const offsetSize = at < 0x100 ? 1 : at < 0x10000 ? 2 : 4;
  const table = Buffer.alloc(offsets.length * offsetSize);
  offsets.forEach((o, i) => table.writeUIntBE(o, i * offsetSize, offsetSize));
  const trailer = Buffer.alloc(32);
  trailer[6] = offsetSize;
  trailer[7] = 2;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(at), 24);
  return Buffer.concat([head, ...objects, table, trailer]);
}

function marker(type, n) {
  return n < 15 ? Buffer.from([type | n]) : Buffer.concat([Buffer.from([type | 0x0f]), int(n)]);
}
function int(n) {
  if (n < 0 || n > 0xffffffff) throw new Error(`bplist: integer out of range ${n}`);
  if (n < 0x100) return Buffer.from([0x10, n]);
  if (n < 0x10000) return Buffer.from([0x11, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = 0x12;
  b.writeUInt32BE(n, 1);
  return b;
}
function refs16(refs) {
  const b = Buffer.alloc(refs.length * 2);
  refs.forEach((r, i) => b.writeUInt16BE(r, i * 2));
  return b;
}
function utf16be(s) {
  const le = Buffer.from(s, 'utf16le');
  for (let i = 0; i < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1], le[i]];
  return le;
}
function fromUtf16be(b) {
  const le = Buffer.from(b);
  for (let i = 0; i < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1], le[i]];
  return le.toString('utf16le');
}

// ---------------------------------------------------------------- alias record (version 2)

const HFS_EPOCH = 2082844800; // seconds from 1904-01-01 to 1970-01-01
const hfsDate = (ms) => Math.max(0, Math.min(0xffffffff, Math.floor(ms / 1000) + HFS_EPOCH));

function pascal(s, total) {
  const bytes = Buffer.from(s, 'latin1');
  if (bytes.length > total - 1) throw new Error(`alias: ${JSON.stringify(s)} is longer than ${total - 1} bytes`);
  const b = Buffer.alloc(total);
  b[0] = bytes.length;
  bytes.copy(b, 1);
  return b;
}

/**
 * A version 2 alias record for a file on the image's volume, from what the mounted volume reports: its name and
 * creation date, the file's and its folder's IDs (inode numbers on HFS+), and the file's creation date. Finder resolves
 * it by volume name and path when the image is mounted later, as for any alias on a disk image.
 *
 * target: { volumeName, volumeCreated (ms), mountPoint, path (from the volume root, '/.background/background.tiff'),
 *           cnid, parentCnid, created (ms) }
 */
export function aliasRecord(target) {
  const parts = target.path.split('/').filter(Boolean);
  const fileName = parts.at(-1);
  const folderName = parts.length > 1 ? parts.at(-2) : target.volumeName;
  const head = Buffer.alloc(150);
  let o = 8; // userType (4), recordSize (2), version (2) are written last
  head.writeUInt16BE(0, o); o += 2; // kind: file
  pascal(target.volumeName, 28).copy(head, o); o += 28;
  head.writeUInt32BE(hfsDate(target.volumeCreated), o); o += 4;
  head.write('H+', o, 'latin1'); o += 2; // file system signature
  head.writeUInt16BE(0, o); o += 2; // drive type: fixed (a mounted image)
  head.writeUInt32BE(target.parentCnid, o); o += 4;
  pascal(fileName, 64).copy(head, o); o += 64;
  head.writeUInt32BE(target.cnid, o); o += 4;
  head.writeUInt32BE(hfsDate(target.created), o); o += 4;
  o += 8; // file type and creator: none
  head.writeInt16BE(-1, o); o += 2; // levels from
  head.writeInt16BE(-1, o); o += 2; // levels to
  o += 4 + 2 + 10; // volume attributes, file system id, reserved
  const tag = (id, data) => {
    const h = Buffer.alloc(4);
    h.writeInt16BE(id, 0);
    h.writeUInt16BE(data.length, 2);
    return Buffer.concat([h, data, Buffer.alloc(data.length % 2)]);
  };
  const ustr = (s) => {
    const u = utf16be(s);
    const n = Buffer.alloc(2);
    n.writeUInt16BE(u.length / 2, 0);
    return Buffer.concat([n, u]);
  };
  const cnidPath = Buffer.alloc(4);
  cnidPath.writeUInt32BE(target.parentCnid, 0);
  const tags = Buffer.concat([
    tag(0, Buffer.from(folderName, 'latin1')),
    tag(1, cnidPath),
    tag(2, Buffer.from([target.volumeName, ...parts].join(':'), 'latin1')),
    tag(14, ustr(fileName)),
    tag(15, ustr(target.volumeName)),
    tag(18, Buffer.from(`/${parts.join('/')}`, 'utf8')),
    tag(19, Buffer.from(target.mountPoint, 'utf8')),
    tag(-1, Buffer.alloc(0)),
  ]);
  const out = Buffer.concat([head, tags]);
  out.writeUInt16BE(out.length, 4);
  out.writeUInt16BE(2, 6);
  return out;
}

/** Reads back what verify-dmg and the tests check in an alias record. */
export function readAlias(b) {
  const version = b.readUInt16BE(6);
  const size = b.readUInt16BE(4);
  const volumeName = b.subarray(11, 11 + b[10]).toString('latin1');
  const fileName = b.subarray(51, 51 + b[50]).toString('latin1');
  const tags = {};
  let o = 150;
  while (o + 4 <= b.length) {
    const id = b.readInt16BE(o);
    const len = b.readUInt16BE(o + 2);
    if (id === -1) break;
    tags[id] = b.subarray(o + 4, o + 4 + len);
    o += 4 + len + (len % 2);
  }
  return {
    version, size, volumeName, fileName,
    parentCnid: b.readUInt32BE(46), cnid: b.readUInt32BE(114),
    posixPath: tags[18]?.toString('utf8'), mountPoint: tags[19]?.toString('utf8'), carbonPath: tags[2]?.toString('latin1'),
    unicodeName: tags[14] ? fromUtf16be(tags[14].subarray(2)) : undefined,
  };
}

// ---------------------------------------------------------------- .DS_Store

/**
 * The layout's records. `alias` is the background picture's alias record; without one (tests, or a build that could
 * not make it) the window gets a plain background colour instead of the picture.
 */
export function layoutRecords(plan, alias) {
  const { x, y, width, height } = plan.window;
  const bwsp = bplist({
    ContainerShowSidebar: false, PreviewPaneVisibility: false, ShowPathbar: false, ShowSidebar: false, ShowStatusBar: false,
    ShowTabView: false, ShowToolbar: false, SidebarWidth: 0, WindowBounds: `{{${x}, ${y}}, {${width}, ${height}}}`,
  });
  const icvp = bplist({
    arrangeBy: 'none', backgroundColorBlue: { real: 0.89 }, backgroundColorGreen: { real: 0.922 }, backgroundColorRed: { real: 0.937 },
    backgroundType: alias ? 2 : 1, ...(alias ? { backgroundImageAlias: alias } : {}),
    gridOffsetX: { real: 0 }, gridOffsetY: { real: 0 }, gridSpacing: { real: 100 }, iconSize: { real: plan.iconSize }, labelOnBottom: true,
    scrollPositionX: { real: 0 }, scrollPositionY: { real: 0 }, showIconPreview: false, showItemInfo: false, textSize: { real: plan.textSize }, viewOptionsVersion: 1,
  });
  return [
    { name: '.', code: 'bwsp', type: 'blob', value: bwsp },
    { name: '.', code: 'icvp', type: 'blob', value: icvp },
    { name: '.', code: 'vSrn', type: 'long', value: 1 },
    { name: '.', code: 'vstl', type: 'type', value: 'icnv' },
    ...plan.items.map((i) => ({ name: i.name, code: 'Iloc', type: 'blob', value: iloc(i.x, i.y) })),
  ];
}

function iloc(x, y) {
  const b = Buffer.alloc(16, 0xff);
  b.writeUInt32BE(x, 0);
  b.writeUInt32BE(y, 4);
  b.writeUInt16BE(0, 14);
  return b;
}

/** Finder's order: names compared case-insensitively, then codes. */
function compareRecords(a, b) {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

function encodeRecord(r) {
  const name = utf16be(r.name);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(name.length / 2, 0);
  const code = Buffer.from(r.code, 'latin1');
  const type = Buffer.from(r.type, 'latin1');
  if (code.length !== 4 || type.length !== 4) throw new Error(`DS_Store: bad code or type ${r.code} ${r.type}`);
  let value;
  if (r.type === 'long' || r.type === 'shor') {
    value = Buffer.alloc(4);
    value.writeUInt32BE(r.value, 0);
  } else if (r.type === 'bool') value = Buffer.from([r.value ? 1 : 0]);
  else if (r.type === 'type') value = Buffer.from(r.value, 'latin1');
  else if (r.type === 'blob') {
    value = Buffer.alloc(4 + r.value.length);
    value.writeUInt32BE(r.value.length, 0);
    r.value.copy(value, 4);
  } else if (r.type === 'ustr') {
    const u = utf16be(r.value);
    value = Buffer.alloc(4);
    value.writeUInt32BE(u.length / 2, 0);
    value = Buffer.concat([value, u]);
  } else throw new Error(`DS_Store: cannot write type ${r.type}`);
  return Buffer.concat([head, name, code, type, value]);
}

/**
 * A .DS_Store holding these records in one leaf node. The file is a buddy allocator over 2^31 bytes: the header block,
 * the allocator's own block (offsets, the "DSDB" directory, free lists), the B-tree's master block and its leaf.
 */
export function dsStore(records) {
  const sorted = [...records].sort(compareRecords);
  const leafBody = Buffer.concat(sorted.map(encodeRecord));
  // One page, as Finder's page size says; a layout this small never needs a second node.
  if (leafBody.length + 8 > 0x1000) throw new Error('DS_Store: the records do not fit one node');
  const leafSize = 0x1000;
  // Buddy allocation, in the order Finder's own files show: header, allocator block, master, leaf.
  const free = Array.from({ length: 32 }, () => []);
  free[31].push(0);
  const alloc = (size) => {
    const want = Math.max(5, Math.ceil(Math.log2(size)));
    let p = want;
    while (p < 32 && !free[p].length) p++;
    if (p === 32) throw new Error('DS_Store: out of space');
    const at = free[p].shift();
    while (p > want) {
      p--;
      free[p].push(at + 2 ** p);
      free[p].sort((a, b) => a - b);
    }
    return { at, log: want };
  };
  alloc(32); // the header
  const info = alloc(2048);
  const master = alloc(32);
  const leaf = alloc(leafSize);
  const blocks = [info, master, leaf];
  const addr = (b) => (b.at | b.log) >>> 0;

  const leafBlock = Buffer.alloc(leafSize);
  leafBlock.writeUInt32BE(0, 0); // a leaf: no children
  leafBlock.writeUInt32BE(sorted.length, 4);
  leafBody.copy(leafBlock, 8);

  const masterBlock = Buffer.alloc(32);
  masterBlock.writeUInt32BE(2, 0); // root node: block 2, the leaf
  masterBlock.writeUInt32BE(0, 4); // levels below the root
  masterBlock.writeUInt32BE(sorted.length, 8);
  masterBlock.writeUInt32BE(1, 12); // nodes
  masterBlock.writeUInt32BE(0x1000, 16); // page size

  const parts = [];
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0, 0);
    parts.push(b);
  };
  u32(blocks.length);
  u32(0);
  for (let i = 0; i < 256; i++) u32(i < blocks.length ? addr(blocks[i]) : 0);
  u32(1); // directory entries
  parts.push(Buffer.from([4]), Buffer.from('DSDB', 'latin1'));
  u32(1); // DSDB is block 1, the master
  for (let p = 0; p < 32; p++) {
    u32(free[p].length);
    for (const at of free[p]) u32(at);
  }
  const infoBody = Buffer.concat(parts);
  if (infoBody.length > 2048) throw new Error('DS_Store: allocator block too large');
  const infoBlock = Buffer.alloc(2048);
  infoBody.copy(infoBlock);

  const end = leaf.at + leafSize;
  const file = Buffer.alloc(4 + end);
  file.writeUInt32BE(1, 0);
  file.write('Bud1', 4, 'latin1');
  file.writeUInt32BE(info.at, 8);
  file.writeUInt32BE(2048, 12);
  file.writeUInt32BE(info.at, 16);
  Buffer.from([0x00, 0x00, 0x10, 0x0c, 0x00, 0x00, 0x00, 0x87, 0x00, 0x00, 0x20, 0x0b, 0x00, 0x00, 0x00, 0x00]).copy(file, 20);
  infoBlock.copy(file, 4 + info.at);
  masterBlock.copy(file, 4 + master.at);
  leafBlock.copy(file, 4 + leaf.at);
  return file;
}

/** Reads a .DS_Store, Finder's own or ours: every record of its B-tree, internal nodes included. */
export function readDsStore(file) {
  if (file.readUInt32BE(0) !== 1 || file.toString('latin1', 4, 8) !== 'Bud1') throw new Error('Not a .DS_Store');
  const infoAt = file.readUInt32BE(8);
  if (file.readUInt32BE(16) !== infoAt) throw new Error('.DS_Store: header offsets differ');
  const info = file.subarray(4 + infoAt);
  const count = info.readUInt32BE(0);
  const addresses = [];
  for (let i = 0; i < count; i++) addresses.push(info.readUInt32BE(8 + i * 4));
  let o = 8 + Math.ceil(count / 256) * 256 * 4;
  const dirs = info.readUInt32BE(o);
  o += 4;
  const toc = {};
  for (let i = 0; i < dirs; i++) {
    const n = info[o];
    const name = info.toString('latin1', o + 1, o + 1 + n);
    toc[name] = info.readUInt32BE(o + 1 + n);
    o += 1 + n + 4;
  }
  const block = (id) => {
    const a = addresses[id];
    if (a === undefined) throw new Error(`.DS_Store: no block ${id}`);
    const at = a & ~0x1f;
    return file.subarray(4 + at, 4 + at + 2 ** (a & 0x1f));
  };
  if (toc.DSDB === undefined) throw new Error('.DS_Store: no DSDB directory');
  const master = block(toc.DSDB);
  const records = [];
  const walk = (id) => {
    const node = block(id);
    const right = node.readUInt32BE(0);
    const n = node.readUInt32BE(4);
    let p = 8;
    for (let i = 0; i < n; i++) {
      if (right) {
        walk(node.readUInt32BE(p));
        p += 4;
      }
      const len = node.readUInt32BE(p);
      const name = fromUtf16be(node.subarray(p + 4, p + 4 + len * 2));
      p += 4 + len * 2;
      const code = node.toString('latin1', p, p + 4);
      const type = node.toString('latin1', p + 4, p + 8);
      p += 8;
      let value;
      if (type === 'long' || type === 'shor') { value = node.readUInt32BE(p); p += 4; }
      else if (type === 'bool') { value = node[p] === 1; p += 1; }
      else if (type === 'type') { value = node.toString('latin1', p, p + 4); p += 4; }
      else if (type === 'blob') { const l = node.readUInt32BE(p); value = Buffer.from(node.subarray(p + 4, p + 4 + l)); p += 4 + l; }
      else if (type === 'ustr') { const l = node.readUInt32BE(p); value = fromUtf16be(node.subarray(p + 4, p + 4 + l * 2)); p += 4 + l * 2; }
      else if (type === 'comp' || type === 'dutc') { value = node.readBigUInt64BE(p); p += 8; }
      else throw new Error(`.DS_Store: unknown type ${type}`);
      records.push({ name, code, type, value });
    }
    if (right) walk(right);
  };
  walk(master.readUInt32BE(0));
  return { records, count: master.readUInt32BE(8) };
}

/** An icon position from an Iloc record. */
export function readIloc(b) {
  return { x: b.readUInt32BE(0), y: b.readUInt32BE(4) };
}

/** FinderInfo for the volume's root folder with "has custom icon" set: the volume shows .VolumeIcon.icns. */
export const CUSTOM_ICON_FINDER_INFO = '0000000000000000040000000000000000000000000000000000000000000000';
