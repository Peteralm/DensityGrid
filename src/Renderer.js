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
  constructor({ container, layout, stack }) {
    /** @type {HTMLCanvasElement} */
    this.container = container
    /** @type {CanvasRenderingContext2D} */
    this.ctx = container.getContext('2d')
    /** @type {Layout} */
    this.layout = layout
    /** @type {AnimationStack} */
    this.stack = stack

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
