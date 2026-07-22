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

    /** @private @type {HTMLCanvasElement|null} cell mask, rebuilt on topology change */
    this._mask = null
    /** @private @type {string} */
    this._maskKey = ''
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
   * The CELL MASK: every lattice cell painted once, at full alpha, in the
   * cell's own shape. Pure geometry — it holds no content, so it survives
   * every frame and is rebuilt only when the lattice or the corner changes.
   *
   * This is the expensive raster (≈5ms for 6528 cells), paid on resize
   * instead of per frame.
   *
   * @private
   * @returns {HTMLCanvasElement}
   */
  _ensureMask(layout) {
    const dpr = layout.dpr
    const r = this.cornerRadius
    const key = `${layout.countX}x${layout.countY}|${layout.step_}|${layout.blockSize}|${layout.originX}|${layout.originY}|${r}|${dpr}|${layout.width}x${layout.height}`
    if (key === this._maskKey && this._mask) return this._mask
    this._maskKey = key

    const mask = this._mask || (this._mask = document.createElement('canvas'))
    mask.width = Math.max(1, Math.round(layout.width * dpr))
    mask.height = Math.max(1, Math.round(layout.height * dpr))
    const mctx = mask.getContext('2d')
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    mctx.fillStyle = '#FFFFFF'
    const bs = layout.blockSize
    const step = layout.step_
    for (let gy = 0; gy < layout.countY; gy++) {
      for (let gx = 0; gx < layout.countX; gx++) {
        const x = layout.originX + gx * step
        const y = layout.originY + gy * step
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
   * So the corner is rasterised ONCE, into a mask, and per frame the plane is:
   *
   *   1. a cols×rows image — one texel per cell, RGB = colour, A = alpha —
   *      blown up with smoothing OFF so each texel covers exactly one cell
   *      stride, and
   *   2. `destination-in` with the mask, which cuts those flat blocks down to
   *      the cell shape and multiplies in the mask's antialiased edge.
   *
   * The result is the same product the per-cell path computes (alpha ×
   * coverage), and measures identical to within 1/255 — the 8-bit floor, on
   * 0.6% of pixels. 6.93ms → 0.045ms for 6528 cells.
   *
   * The half-gap shift is load-bearing. A cell's body starts exactly on its
   * texel boundary, so without the shift the cell's leading edge samples the
   * NEIGHBOUR's texel: max error 4/255 on 1.7% of pixels, which on a weave
   * whose whole range is 14/255 is a visible change of material. Offsetting
   * the blit by half a gap puts every cell body strictly inside its own texel
   * and the error collapses to quantisation.
   *
   * Declines (returns false) when any cell on the plane carries a draw offset:
   * a lattice-aligned texel cannot express a cell painted off its own index.
   *
   * @private
   * @returns {boolean} true if the plane was painted here
   */
  _paintPlaneFast(pctx, layout) {
    const cols = layout.countX
    const rows = layout.countY
    if (cols <= 0 || rows <= 0) return false

    const map = this._ensureMap(cols, rows)
    const img = this._mapImg
    const data = img.data
    data.fill(0)

    let anyOffset = false
    let live = 0
    this.fields.forEachCell((gx, gy, alpha, color, offX, offY) => {
      if (offX !== 0 || offY !== 0) {
        anyOffset = true
        return
      }
      if (alpha <= 0) return
      const j = (gy * cols + gx) * 4
      data[j] = (color >> 16) & 0xff
      data[j + 1] = (color >> 8) & 0xff
      data[j + 2] = color & 0xff
      data[j + 3] = alpha >= 1 ? 255 : (alpha * 255 + 0.5) | 0
      live++
    })
    if (anyOffset) return false
    if (live === 0) return true // plane is already clear; nothing to cut

    const dpr = layout.dpr
    const half = layout.gap / 2
    this._mapCtx.putImageData(img, 0, 0)
    const mask = this._ensureMask(layout)

    const smoothing = pctx.imageSmoothingEnabled
    pctx.imageSmoothingEnabled = false
    pctx.globalAlpha = 1
    pctx.globalCompositeOperation = 'source-over'
    pctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    pctx.drawImage(
      map,
      0, 0, cols, rows,
      layout.originX - half, layout.originY - half,
      cols * layout.step_, rows * layout.step_
    )
    // The mask is already at device resolution, so it goes on untransformed.
    pctx.globalCompositeOperation = 'destination-in'
    pctx.setTransform(1, 0, 0, 1, 0, 0)
    pctx.drawImage(mask, 0, 0)
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

    // Reset transform and clear at full canvas resolution, then
    // apply DPR scale so all drawing uses CSS-pixel coordinates.
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, layout.width * dpr, layout.height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    let lastFill = '#FFFFFF'
    ctx.fillStyle = '#FFFFFF'

    // Field path. Cells come out of the compositor already resolved (which
    // field won, blended or not), so drawing is a flat walk with no per-block
    // animation evaluation. The legacy block path below stays for as long as
    // the old pull-model animations are still in use.
    if (this.fields && this.fields.size > 0) {
      const step = layout.step_
      const ox = layout.originX
      const oy = layout.originY
      const r = this.cornerRadius

      // One compose + one draw per plane. Planes are independent raster
      // targets over ONE lattice — a cell index means the same cell on every
      // plane, so a field that moves from one to another lands pixel-identical.
      for (let p = 0; p < this.planes.length; p++) {
        const plane = this.planes[p]
        const pctx = plane.ctx
        pctx.setTransform(1, 0, 0, 1, 0, 0)
        pctx.clearRect(0, 0, layout.width * dpr, layout.height * dpr)
        pctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        pctx.fillStyle = '#FFFFFF'
        let planeFill = '#FFFFFF'

        this.fields.compose(layout.countX, layout.countY, now, plane.name)

        // Every cell on the lattice, or nothing. `_paintPlaneFast` declines
        // the moment it meets a displaced cell, and the per-cell walk below
        // is the answer for that plane — it is the only one that can put a
        // cell somewhere its lattice index does not.
        if (this._paintPlaneFast(pctx, layout)) {
          pctx.setTransform(1, 0, 0, 1, 0, 0)
          continue
        }

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
