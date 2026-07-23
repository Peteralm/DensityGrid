/**
 * A Field reserves a rectangular REGION of the lattice and owns what gets
 * drawn there. Fields may overlap; `zIndex` decides which one supplies a
 * contested cell, and `blendMode` decides whether the loser is discarded or
 * composited under the winner.
 *
 * Producers are PUSH, not pull: `produce(write)` calls `write()` only for the
 * cells it actually occupies. A dense producer (a background field) is just
 * the case where it walks its whole rect. This is what lets a sparse producer
 * — the 2.5D engine, which already resolved its own z-buffer and hands back
 * ~2/3 of its rect — forward its result without being re-sampled cell by cell.
 *
 * A field writes in ABSOLUTE lattice coordinates. It is not translated into
 * field-local space, because the whole point of the shared lattice is that a
 * cell index means the same thing to everyone.
 */
export class Field {
  /**
   * @param {Object} params
   * @param {string} params.name - identifier, for debug listings
   * @param {(write: (gx: number, gy: number, alpha: number, color?: number, offX?: number, offY?: number, rot?: number) => void, time: number) => void} params.produce
   *   `offX`/`offY` are a DRAW offset in px (default 0) and `rot` is a DRAW
   *   rotation in radians about the cell's own centre (default 0): the cell
   *   keeps its lattice identity for composition (blendMode, zIndex, clipping)
   *   but is painted displaced and turned. This is how a field renders smooth
   *   sub-cell motion — a hover warp, a shiver, a tumble — without breaking
   *   phase lock: at rest all three are zero and the lattice is bit-identical
   *   to never having had them.
   * @param {{col: number, row: number, cols: number, rows: number}} [params.rect]
   *   Region in lattice cells. Defaults to the whole lattice; set it (or keep
   *   it in sync via `Layout.cellRectFromPx`) to bound the field to a section.
   * @param {number} [params.zIndex=0] - higher wins a contested cell
   * @param {'Absolute'|'Blend'} [params.blendMode='Absolute'] - how this field
   *   combines with whatever a lower field already put in the cell.
   *   `Absolute` occludes: it replaces colour, alpha AND geometry outright.
   *   `Blend` mixes both, weighted by alpha — see FieldStack.compose.
   * @param {'replace'|'blend'} [params.merge] - the old spelling of
   *   `blendMode`, still accepted and mapped. `replace`→`Absolute`,
   *   `blend`→`Blend`.
   * @param {boolean} [params.active=true] - false: `produce` is never called,
   *   and the field contributes nothing. This is the render-cost gate; drive
   *   it from an IntersectionObserver on the owning section.
   * @param {string} [params.plane='base'] - which canvas this field rasterises
   *   into. `zIndex` orders fields against each other; `plane` orders them
   *   against the PAGE — it is what lets DOM content (a <video>, an <img>) sit
   *   between two fields, which a single canvas cannot express. The lattice,
   *   the compositor and the loop stay single; only the raster target differs,
   *   so phase lock across planes is exact by construction. Unknown plane
   *   names are dropped by the renderer rather than silently drawn to base.
   */
  constructor({ name, produce, rect = null, zIndex = 0, blendMode, merge, active = true, plane = 'base' }) {
    /** @type {string} */
    this.name = name || 'field'
    /** @type {Function} */
    this.produce = produce
    /** @type {{col:number,row:number,cols:number,rows:number}|null} null = whole lattice */
    this.rect = rect
    /** @type {number} */
    this.zIndex = zIndex
    /**
     * `blendMode` is the name; `merge` is the same axis under its old
     * spelling, kept working so the consumer can be migrated on its own
     * schedule instead of in the same commit as the library.
     * @type {'Absolute'|'Blend'}
     */
    this.blendMode = blendMode || (merge === 'blend' ? 'Blend' : 'Absolute')
    /** @type {boolean} */
    this.active = active
    /** @type {string} raster target; see the constructor doc */
    this.plane = plane
  }

  /**
   * The old spelling, as a live view of `blendMode` rather than a second
   * field — two properties for one axis is how they drift apart.
   * @deprecated use `blendMode`
   * @type {'replace'|'blend'}
   */
  get merge() {
    return this.blendMode === 'Blend' ? 'blend' : 'replace'
  }

  set merge(v) {
    this.blendMode = v === 'blend' ? 'Blend' : 'Absolute'
  }

  /**
   * Point the field at a DOM element's box. Call on resize / scroll; the
   * result is snapped to whole cells so the field never lands off-phase.
   *
   * @param {DOMRect|{x:number,y:number,width:number,height:number}} box
   *   Coordinates must already be in the canvas's CSS-pixel space.
   * @param {import('./Layout.js').Layout} layout
   * @returns {this}
   */
  setRectFromBox(box, layout) {
    this.rect = layout.cellRectFromPx(box.x, box.y, box.width, box.height)
    return this
  }
}

/**
 * Composites the active fields into one cell surface per frame.
 *
 * Resolution is a single bottom-up pass in zIndex order: a later (higher)
 * field's `Absolute` simply overwrites, and its `Blend` composites over what
 * is already there. Both colour AND geometry (offX, offY, rot) follow that
 * rule, on the same alpha weights. No occlusion pre-pass — an opaque top field could in
 * principle let lower fields skip their covered cells, but the overlap is a
 * few thousand cells against a total that is already in the same order of
 * magnitude, so the bookkeeping would cost more than it saves. Revisit only if
 * a profile says otherwise.
 *
 * Clearing is zero-cost: a `stamp` array plus an incrementing `frameId` marks
 * live cells instead of wiping the channels (same trick the 2.5D engine uses).
 */
export class FieldStack {
  constructor() {
    /** @private @type {Field[]} */
    this._fields = []
    /** @private sorted view, rebuilt when membership or zIndex changes */
    this._sorted = []
    /** @private */
    this._sortDirty = false

    /** @private lattice dimensions the buffers were allocated for */
    this._cols = 0
    this._rows = 0
    /** @private @type {Uint32Array} */
    this._stamp = new Uint32Array(0)
    /** @private @type {Float32Array} */
    this._alpha = new Float32Array(0)
    /** @private @type {Uint32Array} packed 0xRRGGBB */
    this._color = new Uint32Array(0)
    /** @private @type {Float32Array} draw offset px */
    this._offX = new Float32Array(0)
    /** @private @type {Float32Array} draw offset px */
    this._offY = new Float32Array(0)
    /** @private @type {Float32Array} draw rotation, radians about cell centre */
    this._rot = new Float32Array(0)
    /** @private @type {Int32Array} touched-cell indices, for packing */
    this._dirty = new Int32Array(0)
    /** @private */
    this._dirtyCount = 0
    /** @private */
    this._frameId = 0
  }

  /** @returns {number} how many fields are registered */
  get size() {
    return this._fields.length
  }

  /**
   * @param {Field} field
   * @returns {() => void} remove
   */
  add(field) {
    this._fields.push(field)
    this._sortDirty = true
    return () => this.remove(field)
  }

  /** @param {Field} field */
  remove(field) {
    const i = this._fields.indexOf(field)
    if (i >= 0) {
      this._fields.splice(i, 1)
      this._sortDirty = true
    }
  }

  /** @returns {Array<{name: string, zIndex: number, blendMode: string, active: boolean, plane: string}>} */
  list() {
    return this._fields.map((f) => ({
      name: f.name,
      zIndex: f.zIndex,
      blendMode: f.blendMode,
      active: f.active,
      plane: f.plane,
    }))
  }

  /**
   * Run every active field and composite the result.
   *
   * Called once per PLANE per frame. The stamp/frameId trick that makes
   * clearing free also makes the per-plane passes independent: each pass
   * bumps `frameId`, so the previous plane's cells stop counting as live
   * without a wipe. Cost is proportional to the cells a plane actually
   * writes, not to the number of planes.
   *
   * @param {number} cols lattice columns
   * @param {number} rows lattice rows
   * @param {number} time DOMHighResTimeStamp passed through to producers
   * @param {string} [plane] compose only fields on this plane; omit for all
   */
  compose(cols, rows, time, plane) {
    this._ensure(cols, rows)
    // zIndex is re-read every frame a field is added/removed; a field that
    // mutates its own zIndex between those points is re-sorted here too, since
    // sorting a handful of entries is cheaper than tracking the invalidation.
    if (this._sortDirty || this._sorted.length !== this._fields.length) {
      this._sorted = this._fields.slice()
      this._sortDirty = false
    }
    this._sorted.sort((a, b) => a.zIndex - b.zIndex)

    const frameId = ++this._frameId
    const stamp = this._stamp
    const alpha = this._alpha
    const color = this._color
    const offX = this._offX
    const offY = this._offY
    const rot = this._rot
    const dirty = this._dirty
    let dirtyCount = 0

    for (let f = 0; f < this._sorted.length; f++) {
      const field = this._sorted[f]
      if (!field.active || typeof field.produce !== 'function') continue
      if (plane !== undefined && field.plane !== plane) continue

      // Clip to the field's rect, so a producer that writes outside its own
      // region is contained rather than corrupting a neighbour.
      const r = field.rect
      const cMin = r ? r.col : 0
      const rMin = r ? r.row : 0
      const cMax = r ? r.col + r.cols - 1 : cols - 1
      const rMax = r ? r.row + r.rows - 1 : rows - 1
      const blend = field.blendMode === 'Blend'

      const write = (gx, gy, a, c, ox, oy, rt) => {
        if (gx < cMin || gx > cMax || gy < rMin || gy > rMax) return
        if (gx < 0 || gx >= cols || gy < 0 || gy >= rows) return
        if (!(a > 0)) return
        if (a > 1) a = 1
        const idx = gy * cols + gx
        const fresh = stamp[idx] !== frameId
        if (fresh) {
          stamp[idx] = frameId
          dirty[dirtyCount++] = idx
          alpha[idx] = a
          color[idx] = c === undefined ? 0xffffff : c
          offX[idx] = ox === undefined ? 0 : ox
          offY[idx] = oy === undefined ? 0 : oy
          rot[idx] = rt === undefined ? 0 : rt
          return
        }
        if (!blend) {
          // Absolute OCCLUDES. Everything about the cell is replaced —
          // colour, alpha and geometry alike — because a field declaring
          // itself opaque is declaring that what is under it stopped
          // existing, and a surviving offset from below would be the cell
          // half-remembering a producer that lost.
          alpha[idx] = a
          color[idx] = c === undefined ? 0xffffff : c
          offX[idx] = ox === undefined ? 0 : ox
          offY[idx] = oy === undefined ? 0 : oy
          rot[idx] = rt === undefined ? 0 : rt
          return
        }
        // Source-over on premultiplied-by-alpha channels: the incoming cell
        // covers `a` of the result, the existing one keeps (1 - a) of its own.
        const below = alpha[idx]
        const out = a + below * (1 - a)
        if (out > 0) {
          const cb = color[idx]
          const ct = c === undefined ? 0xffffff : c
          const wTop = a / out
          const wBot = 1 - wTop
          const r8 = ((ct >> 16) & 0xff) * wTop + ((cb >> 16) & 0xff) * wBot
          const g8 = ((ct >> 8) & 0xff) * wTop + ((cb >> 8) & 0xff) * wBot
          const b8 = (ct & 0xff) * wTop + (cb & 0xff) * wBot
          color[idx] = ((r8 & 0xff) << 16) | ((g8 & 0xff) << 8) | (b8 & 0xff)
          // GEOMETRY MIXES ON THE SAME WEIGHTS AS COLOUR. There is exactly one
          // cell, so two Blend fields disagreeing about where it sits is the
          // same kind of disagreement as two fields disagreeing about its
          // colour, and it is answered the same way. This reverses an earlier
          // rule that let the topmost writer own the motion outright; that
          // rule was written when `blend` meant "tint what is underneath" and
          // the only mover was the top field, so top-wins and the average were
          // indistinguishable in practice. They stop being indistinguishable
          // once two fields both move, and averaging is the one that keeps a
          // single cell reading as a single object.
          //
          // Angle averages NUMERICALLY, with no wraparound handling: 350° and
          // 10° resolve to 180°, not 0°. That is the chosen semantics, not an
          // oversight. A shortest-arc fix would make the result depend on how
          // each producer happened to phrase its angle, and a cell has no
          // notion of which turn was "meant".
          offX[idx] = (ox === undefined ? 0 : ox) * wTop + offX[idx] * wBot
          offY[idx] = (oy === undefined ? 0 : oy) * wTop + offY[idx] * wBot
          rot[idx] = (rt === undefined ? 0 : rt) * wTop + rot[idx] * wBot
        }
        alpha[idx] = out
      }

      field.produce(write, time)
    }

    this._dirtyCount = dirtyCount
  }

  /**
   * Walk the cells written by the last `compose()`.
   *
   * @param {(gx: number, gy: number, alpha: number, color: number, offX: number, offY: number, rot: number) => void} fn
   */
  forEachCell(fn) {
    const cols = this._cols
    const dirty = this._dirty
    const alpha = this._alpha
    const color = this._color
    const offX = this._offX
    const offY = this._offY
    const rot = this._rot
    for (let k = 0; k < this._dirtyCount; k++) {
      const idx = dirty[k]
      fn(idx % cols, (idx / cols) | 0, alpha[idx], color[idx], offX[idx], offY[idx], rot[idx])
    }
  }

  /** @private */
  _ensure(cols, rows) {
    if (cols === this._cols && rows === this._rows) return
    const n = Math.max(0, cols * rows)
    this._cols = cols
    this._rows = rows
    this._stamp = new Uint32Array(n)
    this._alpha = new Float32Array(n)
    this._color = new Uint32Array(n)
    this._offX = new Float32Array(n)
    this._offY = new Float32Array(n)
    this._rot = new Float32Array(n)
    this._dirty = new Int32Array(n)
    this._dirtyCount = 0
    this._frameId = 0
  }
}
