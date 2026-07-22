/**
 * Owns the requestAnimationFrame loop. Each tick it walks the
 * layout's block list, asks the AnimationStack for per-block
 * offsets, and draws the result to the canvas 2D context.
 *
 * The loop is always running once start() is called — an empty
 * stack still produces a valid base-state frame (opaque white
 * blocks at their layout positions).
 *
 * Priority rule (CLAUDE.md §6): for each property (opacity,
 * position), if an offset contribution is present, it wins over
 * any absolute override. Absolute only applies when no offset
 * was provided.
 */
export class Renderer {
  /**
   * @param {Object} params
   * @param {HTMLCanvasElement} params.container
   * @param {Layout} params.layout
   * @param {AnimationStack} params.stack
   */
  constructor({ container, layout, stack, fields = null, cornerRadius = 0, planes = null }) {
    /** @type {HTMLCanvasElement} */
    this.container = container
    /** @type {CanvasRenderingContext2D} */
    this.ctx = container.getContext('2d')

    // Raster targets, drawn in array order. `container` is always the 'base'
    // plane, so a grid constructed without `planes` behaves exactly as before.
    // Extra planes exist so page content can be sandwiched between fields —
    // see Field.plane. Each plane is a separate canvas the consumer positions
    // itself; the lattice they share is this Renderer's single Layout.
    /** @type {Array<{name: string, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D}>} */
    this.planes = [{ name: 'base', canvas: container, ctx: this.ctx }]
    if (planes) {
      for (const name in planes) {
        const canvas = planes[name]
        if (!canvas || name === 'base') continue
        this.planes.push({ name, canvas, ctx: canvas.getContext('2d') })
      }
    }
    /** @type {Layout} */
    this.layout = layout
    /** @type {AnimationStack} */
    this.stack = stack
    /** @type {import('./Field.js').FieldStack|null} */
    this.fields = fields
    /** @type {number} block corner radius in px (0 = square corners) */
    this.cornerRadius = cornerRadius

    // MEASURED, do not "optimise" this again without re-measuring:
    // replacing the per-cell beginPath+roundPath+fill below with a cached
    // cell sprite + PER-CELL drawImage makes this renderer SLOWER (5.6ms →
    // 8.2ms on a 110×56 lattice). The sprite has to be rasterised at
    // blockSize×dpr and is then blitted into a context already scaled by
    // dpr, so every blit lands on a non-integer scale and pays for
    // resampling.
    //
    // The prototype in claude-design claims the sprite is ~20× cheaper
    // "and is also what the real densitygrid does". Neither half is true
    // here; that comment describes an unscaled canvas.
    //
    // That failure is about ONE BLIT PER CELL. It says nothing about the
    // mask path in `_paintPlaneFast`, which blits twice for the whole
    // plane at 1:1 device pixels and never resamples a cell — see the
    // comment there for why it is a different technique and what it cost.

    /** @private @type {HTMLCanvasElement|null} cell mask STRIP, rebuilt on topology change */
    this._mask = null
    /** @private @type {string} */
    this._maskKey = ''
    /** @private @type {number} lattice rows per mask strip */
    this._stripRows = 0
    /** @private @type {HTMLCanvasElement|null} cols×rows colour+alpha map */
    this._map = null
    /** @private @type {CanvasRenderingContext2D|null} */
    this._mapCtx = null
    /** @private @type {ImageData|null} */
    this._mapImg = null

    /** @type {number} rAF handle */
    this._rafId = 0
    /** @type {boolean} */
    this._running = false

    this._tick = this._tick.bind(this)
  }

  /**
   * Where a plane's canvas sits in the document, in CSS px, and how tall it
   * is. A plane covers a BAND of the page — the section it serves — not the
   * viewport and not the whole document, so painting has to translate into it.
   *
   * This also sizes the backing store, because Layout stopped doing that when
   * the lattice moved into document space: there is no single canvas size to
   * derive any more.
   *
   * @param {string} name
   * @param {{top: number, height: number}} box
   */
  setPlaneBox(name, box) {
    const plane = this.planes.find((p) => p.name === name)
    if (!plane) return
    plane.box = { top: box.top, height: box.height }
    this._sizePlane(plane)
  }

  /**
   * Write the canvas's intrinsic size from its band. THE RUNAWAY HAZARD LIVES
   * HERE NOW: <canvas> is a REPLACED element, so with no CSS size its CSS box
   * IS its intrinsic size. If a band were ever derived from a measurement of
   * the canvas itself, this write would grow it by `dpr` on every pass until
   * the cell count melts the frame — silently, with nothing in the console
   * pointing at CSS. It is safe only because a band comes from the SECTION the
   * plane serves, never from the plane. Keep it that way.
   * @private
   */
  _sizePlane(plane) {
    const layout = this.layout
    const dpr = layout.dpr
    const w = Math.max(1, Math.round(layout.fieldWidth * dpr))
    const h = Math.max(1, Math.round(plane.box.height * dpr))
    if (plane.canvas.width !== w) plane.canvas.width = w
    if (plane.canvas.height !== h) plane.canvas.height = h
  }

  /**
   * A plane nobody declared a band for falls back to its own CSS box, pinned
   * to the top of the document. That is only ever right for a page whose
   * canvas already covers what it should; it exists so the library keeps
   * working for a consumer that has not adopted `setPlaneBox` yet.
   * @private
   */
  _ensureBox(plane) {
    if (!plane.box) {
      const rect = plane.canvas.getBoundingClientRect()
      plane.box = { top: 0, height: rect.height || this.layout.fieldHeight }
    }
    // Re-asserted every frame rather than on a resize hook: it is two integer
    // comparisons, and it means a DPR change or a re-solved lattice cannot
    // leave a plane at a stale backing-store size.
    this._sizePlane(plane)
    return plane.box
  }

  start() {
    if (this._running) return
    this._running = true
    this._rafId = requestAnimationFrame(this._tick)
  }

  stop() {
    this._running = false
    if (this._rafId) {
      cancelAnimationFrame(this._rafId)
      this._rafId = 0
    }
  }

  /**
   * @param {number} now - DOMHighResTimeStamp from rAF
   * @private
   */
  _tick(now) {
    if (!this._running) return
    this._draw(now)
    this._rafId = requestAnimationFrame(this._tick)
  }

  /**
   * Rows per mask strip.
   *
   * A document-tall mask is unaffordable — at 1440×3335 and dpr 1.5 it is
   * 43MB, per plane. But the lattice is PERIODIC in whole steps, so a strip
   * holding a whole number of rows has identical cell phase wherever it is
   * placed: one strip serves every band of every plane, and the memory goes
   * back to O(viewport).
   *
   * The count is not simply "a viewport's worth". A strip is blitted at device
   * resolution, so it has to land on an integer device pixel, and a strip whose
   * device height is fractional would drift a fraction of a pixel per strip —
   * a lattice with one uneven gap every N rows, which is exactly the defect
   * class this library already learned to hate. So: search around a viewport's
   * worth for the row count whose device height is nearest a whole pixel. In
   * practice the residual comes out under 1/100 px, which means every strip
   * rounds identically and the mask has ONE constant sub-pixel offset against
   * the map rather than a per-strip one.
   *
   * @private
   */
  _pickStripRows(layout) {
    const S = layout.step_ * layout.dpr
    const vh = typeof window !== 'undefined' ? window.innerHeight : 900
    const target = Math.max(8, Math.floor(vh / layout.step_))
    const lo = Math.max(8, Math.floor(target * 0.75))
    const hi = Math.max(lo + 1, Math.ceil(target * 1.25))
    // SMALLEST candidate that lands close enough to a whole device pixel, not
    // the closest one. Ranking by residual alone ignores how far from target
    // it is, and a strip is a full-page-width raster — picking the top of the
    // range because it aligned prettily cost 24% more mask than the viewport
    // needs, for a difference no one can see. A tenth of a device pixel is
    // already an order of magnitude under the antialiased edge it sits in.
    const TOL = 0.1
    let best = target
    let bestErr = Infinity
    for (let n = lo; n <= hi; n++) {
      const h = n * S
      const err = Math.abs(h - Math.round(h))
      if (err <= TOL) return n
      if (err < bestErr) {
        bestErr = err
        best = n
      }
    }
    return best
  }

  /**
   * The CELL MASK: one strip of lattice cells painted at full alpha in the
   * cell's own shape. Pure geometry — it holds no content, so it survives
   * every frame and is rebuilt only when the lattice or the corner changes.
   *
   * This is the expensive raster (≈5ms for a viewport of cells), paid on
   * resize instead of per frame.
   *
   * The strip's own origin is 0, NOT `originY`: the document origin is applied
   * when the strip is placed. That is what lets one strip serve every band.
   *
   * @private
   * @returns {HTMLCanvasElement}
   */
  _ensureMask(layout) {
    const dpr = layout.dpr
    const r = this.cornerRadius
    const rows = this._pickStripRows(layout)
    const key = `${layout.countX}|${rows}|${layout.step_}|${layout.blockSize}|${layout.originX}|${r}|${dpr}|${layout.fieldWidth}`
    if (key === this._maskKey && this._mask) return this._mask
    this._maskKey = key
    this._stripRows = rows

    const mask = this._mask || (this._mask = document.createElement('canvas'))
    mask.width = Math.max(1, Math.round(layout.fieldWidth * dpr))
    mask.height = Math.max(1, Math.round(rows * layout.step_ * dpr))
    const mctx = mask.getContext('2d')
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    mctx.fillStyle = '#FFFFFF'
    const bs = layout.blockSize
    const step = layout.step_
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < layout.countX; gx++) {
        const x = layout.originX + gx * step
        const y = gy * step
        if (r > 0) {
          mctx.beginPath()
          mctx.roundRect(x, y, bs, bs, r)
          mctx.fill()
        } else {
          mctx.fillRect(x, y, bs, bs)
        }
      }
    }
    return mask
  }

  /** @private one texel per cell: RGB = colour, A = alpha */
  _ensureMap(cols, rows) {
    const map = this._map || (this._map = document.createElement('canvas'))
    if (map.width !== cols || map.height !== rows) {
      map.width = cols
      map.height = rows
      this._mapCtx = map.getContext('2d')
      this._mapImg = this._mapCtx.createImageData(cols, rows)
    }
    return map
  }

  /**
   * Paint a whole plane in TWO blits, independent of how many cells are lit.
   *
   * The per-cell walk costs one `beginPath`+`roundRect`+`fill` per cell, and
   * MEASURED, that is not per-call overhead — it is rasterising thousands of
   * antialiased rounded paths. Bucketing the cells into a handful of shared
   * `Path2D`s cuts the main thread 3× and does not move the frame at all
   * (33.4ms either way). Painting the same cells square instead of rounded
   * takes a 45.7ms frame to 4.2ms. The corner is the whole bill.
   *
   * So the corner is rasterised ONCE, into a mask strip, and per frame the
   * plane is:
   *
   *   1. the mask strip stamped down the band, building a stencil of cell
   *      SHAPES at full alpha, and
   *   2. a cols×rows image — one texel per cell, RGB = colour, A = alpha —
   *      blown up with smoothing OFF so each texel covers exactly one cell
   *      stride, composited `source-in` so it is kept only where the stencil
   *      is, multiplied by the stencil's antialiased edge.
   *
   * The result is the same product the per-cell path computes (alpha ×
   * coverage), and measures identical to within 1/255 — the 8-bit floor, on
   * 0.6% of pixels. 6.93ms → 0.045ms for 6528 cells.
   *
   * THE ORDER IS NOT ARBITRARY, and the obvious version is wrong. Painting the
   * colour first and cutting it with `destination-in` — which is what this did
   * while a plane was a single viewport — cannot survive a banded mask: the
   * `-in` operators composite over the WHOLE canvas, not over the rectangle
   * being drawn, so the second strip's `destination-in` erases the first
   * strip's output. Stencil first, colour `source-in` last, means the colour
   * arrives as ONE blit no matter how tall the band is, and the operator's
   * global reach becomes the feature: everything the stencil did not keep is
   * cleared for free, so the band needs no `clearRect` at all.
   *
   * The half-gap shift is load-bearing. A cell's body starts exactly on its
   * texel boundary, so without the shift the cell's leading edge samples the
   * NEIGHBOUR's texel: max error 4/255 on 1.7% of pixels, which on a weave
   * whose whole range is 14/255 is a visible change of material. Offsetting
   * the blit by half a gap puts every cell body strictly inside its own texel
   * and the error collapses to quantisation.
   *
   * Offsets are accepted in exactly one shape: the SAME one on every cell.
   *
   * A per-cell offset is content — this cell went somewhere that one did not —
   * and a lattice-aligned texel cannot express it, so the per-cell walk has to
   * take that plane. But one offset shared by the whole plane is not content,
   * it is the layer sliding: a scroll, a parallax. Nothing about the plane's
   * internal arrangement changed, so it costs a translation of the two blits
   * and nothing else.
   *
   * The seam this leaves is at the lattice EDGE. A shared offset moves the
   * fabric off its own boundary by up to the offset, and there is no cell
   * beyond row -1 to fill what it uncovers, so the outermost row or column is
   * cut by that much. Keep the shared offset inside half a step — a consumer
   * scrolling should hand over whole cells plus the remainder, the way the
   * lattice expects — and the seam stays under half a cell at the border.
   *
   * @private
   * @returns {boolean} true if the plane was painted here
   */
  _paintPlaneFast(pctx, layout, box, oyLocal) {
    const cols = layout.countX
    const rows = layout.countY
    if (cols <= 0 || rows <= 0) return false

    const map = this._ensureMap(cols, rows)
    const img = this._mapImg
    const data = img.data
    data.fill(0)

    let mixed = false
    let live = 0
    let shiftX = 0
    let shiftY = 0
    this.fields.forEachCell((gx, gy, alpha, color, offX, offY) => {
      if (alpha <= 0) return
      if (live === 0) {
        shiftX = offX
        shiftY = offY
      } else if (offX !== shiftX || offY !== shiftY) {
        mixed = true
        return
      }
      const j = (gy * cols + gx) * 4
      data[j] = (color >> 16) & 0xff
      data[j + 1] = (color >> 8) & 0xff
      data[j + 2] = color & 0xff
      data[j + 3] = alpha >= 1 ? 255 : (alpha * 255 + 0.5) | 0
      live++
    })
    if (mixed) return false

    const dpr = layout.dpr
    const step = layout.step_
    const mask = this._ensureMask(layout)
    const stripRows = this._stripRows
    const stripH = stripRows * step

    // Which strips touch this band. A plane only ever rasterises the slice of
    // the document its canvas covers, so a section far up the page costs
    // nothing to a section far down it.
    const s0 = Math.max(0, Math.floor(-oyLocal / stripH))
    const s1 = Math.min(
      Math.ceil(rows / stripRows) - 1,
      Math.floor((box.height - oyLocal) / stripH)
    )

    if (live === 0) {
      // Nothing lit. The stencil-then-source-in pass would clear the plane as
      // a side effect, but with no colour to draw there is no pass — so clear.
      pctx.setTransform(1, 0, 0, 1, 0, 0)
      pctx.clearRect(0, 0, pctx.canvas.width, pctx.canvas.height)
      return true
    }
    if (s1 < s0) {
      pctx.setTransform(1, 0, 0, 1, 0, 0)
      pctx.clearRect(0, 0, pctx.canvas.width, pctx.canvas.height)
      return true
    }

    const half = layout.gap / 2
    this._mapCtx.putImageData(img, 0, 0)

    const smoothing = pctx.imageSmoothingEnabled
    pctx.imageSmoothingEnabled = false
    pctx.globalAlpha = 1

    // 1. The stencil. Device resolution, so it goes on untransformed. `copy`
    //    on the first strip clears whatever the last frame left; the rest
    //    accumulate. The shift is applied here as well as to the colour, or
    //    the shapes would stay put while their colours slid out from under.
    pctx.setTransform(1, 0, 0, 1, 0, 0)
    pctx.globalCompositeOperation = 'copy'
    for (let s = s0; s <= s1; s++) {
      pctx.drawImage(
        mask,
        shiftX * dpr,
        Math.round((oyLocal + s * stripH) * dpr) + shiftY * dpr
      )
      pctx.globalCompositeOperation = 'source-over'
    }

    // 2. The colour, in one blit whatever the band's height, kept only where
    //    the stencil is. Everything else on the canvas is cleared by the same
    //    operator — see the header.
    pctx.globalCompositeOperation = 'source-in'
    pctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    pctx.drawImage(
      map,
      0, 0, cols, rows,
      layout.originX - half + shiftX, oyLocal - half + shiftY,
      cols * step, rows * step
    )

    pctx.globalCompositeOperation = 'source-over'
    pctx.imageSmoothingEnabled = smoothing
    return true
  }

  /**
   * Clear + draw one frame. Pulls evaluated offsets from the stack
   * and applies them on top of base state (opacity 1, white).
   *
   * @param {number} now
   * @private
   */
  _draw(now) {
    const ctx = this.ctx
    const layout = this.layout
    const stack = this.stack
    const blockSize = layout.blockSize
    const blocks = layout.blocks
    const dpr = layout.dpr

    // Field path. Cells come out of the compositor already resolved (which
    // field won, blended or not), so drawing is a flat walk with no per-block
    // animation evaluation. The legacy block path below stays for as long as
    // the old pull-model animations are still in use.
    if (this.fields && this.fields.size > 0) {
      const step = layout.step_
      const ox = layout.originX
      const r = this.cornerRadius

      // One compose + one draw per plane. Planes are independent raster
      // targets over ONE lattice — a cell index means the same cell on every
      // plane, so a field that moves from one to another lands pixel-identical.
      for (let p = 0; p < this.planes.length; p++) {
        const plane = this.planes[p]
        const pctx = plane.ctx
        const box = this._ensureBox(plane)
        if (!(box.height > 0)) continue

        // The lattice is document space and this canvas is a band of it, so
        // every y is written band-local. There is no scroll term anywhere in
        // here — that is the point of the arrangement.
        const oy = layout.originY - box.top

        pctx.fillStyle = '#FFFFFF'
        let planeFill = '#FFFFFF'

        this.fields.compose(layout.countX, layout.countY, now, plane.name)

        // Every cell on the lattice, or nothing. `_paintPlaneFast` declines
        // the moment it meets a displaced cell, and the per-cell walk below
        // is the answer for that plane — it is the only one that can put a
        // cell somewhere its lattice index does not.
        if (this._paintPlaneFast(pctx, layout, box, oy)) {
          pctx.setTransform(1, 0, 0, 1, 0, 0)
          continue
        }

        // The fast path clears as a side effect of its final `source-in`; the
        // per-cell walk has no such operator, so it clears for itself.
        pctx.setTransform(1, 0, 0, 1, 0, 0)
        pctx.clearRect(0, 0, plane.canvas.width, plane.canvas.height)
        pctx.setTransform(dpr, 0, 0, dpr, 0, 0)

        this.fields.forEachCell((gx, gy, alpha, color, offX, offY) => {
          if (alpha <= 0) return
          const fill =
            color === 0xffffff
              ? '#FFFFFF'
              : `rgb(${(color >> 16) & 0xff},${(color >> 8) & 0xff},${color & 0xff})`
          if (fill !== planeFill) {
            pctx.fillStyle = fill
            planeFill = fill
          }
          pctx.globalAlpha = alpha > 1 ? 1 : alpha
          // offX/offY: sub-cell DRAW displacement — composition stayed on the
          // lattice, only the paint slides.
          const x = ox + gx * step + offX
          const y = oy + gy * step + offY
          if (r > 0) {
            pctx.beginPath()
            pctx.roundRect(x, y, blockSize, blockSize, r)
            pctx.fill()
          } else {
            pctx.fillRect(x, y, blockSize, blockSize)
          }
        })
        pctx.globalAlpha = 1
        pctx.setTransform(1, 0, 0, 1, 0, 0)
      }
      return
    }

    // Legacy per-block path. It never learned about planes or bands, so it
    // still owns the container outright and clears it whole.
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.container.width, this.container.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    let lastFill = '#FFFFFF'
    ctx.fillStyle = '#FFFFFF'

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      const offsets = stack.evaluate(block, now)

      // --- Opacity: offset wins over absolute ---
      // Base opacity is 1. If any animation contributed an
      // opacityOffset, apply it on top of base. Otherwise, if
      // an absoluteOpacity is present, use it verbatim.
      let opacity
      const opacityOffset = offsets.opacityOffset || 0
      if (opacityOffset !== 0) {
        opacity = 1 + opacityOffset
      } else if (
        offsets.absoluteOpacity !== null &&
        offsets.absoluteOpacity !== undefined
      ) {
        opacity = offsets.absoluteOpacity
      } else {
        opacity = 1
      }
      if (opacity < 0) opacity = 0
      else if (opacity > 1) opacity = 1

      if (opacity <= 0) continue

      // --- Position: offset wins over absolute ---
      let x = block.x
      let y = block.y
      const offPos = offsets.offsetPosition
      const offX = offPos ? offPos.x || 0 : 0
      const offY = offPos ? offPos.y || 0 : 0
      if (offX !== 0 || offY !== 0) {
        x = block.x + offX
        y = block.y + offY
      } else if (offsets.absolutePosition) {
        x = offsets.absolutePosition.x
        y = offsets.absolutePosition.y
      }

      // --- Color: per-block override, falls back to white base ---
      const c = offsets.color
      const fill = c ? `rgb(${c.r},${c.g},${c.b})` : '#FFFFFF'
      if (fill !== lastFill) {
        ctx.fillStyle = fill
        lastFill = fill
      }

      ctx.globalAlpha = opacity
      ctx.fillRect(x, y, blockSize, blockSize)
    }

    ctx.globalAlpha = 1
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }
}
