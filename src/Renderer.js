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
    // cell sprite + drawImage makes this renderer SLOWER (5.6ms → 8.2ms on
    // a 110×56 lattice). The sprite has to be rasterised at blockSize×dpr
    // and is then blitted into a context already scaled by dpr, so every
    // blit lands on a non-integer scale and pays for resampling. The
    // sprite trick only wins in an unscaled context that blits at 1:1
    // device pixels — which this renderer cannot do without quantising the
    // sub-cell offX/offY offsets that the smooth-motion path depends on.
    //
    // The prototype in claude-design claims the sprite is ~20× cheaper
    // "and is also what the real densitygrid does". Neither half is true
    // here; that comment describes an unscaled canvas.

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
