/**
 * Computes block positions, gap, and handles resize.
 * Knows nothing about rendering or animations.
 *
 * Owns a ResizeObserver on the container so layout stays in sync
 * with the element's rendered size. Consumers (e.g. Renderer) just
 * read `blocks`, `width`, `height` each frame — no subscription
 * needed.
 */
export class Layout {
  /**
   * @param {Object} params
   * @param {HTMLCanvasElement} params.container
   * @param {number} params.blockSize
   * @param {number} [params.countX] - fixed column count (omit when using step)
   * @param {number} [params.countY] - fixed row count (omit when using step)
   * @param {number} [params.step] - target block+gap step in px. When set,
   *   countX/countY are derived from container size on every recalculate,
   *   so the grid re-tiles itself on window resize.
   * @param {number} [params.fieldHeight] - optional override for the
   *   vertical extent used to compute block positions + countY. Defaults
   *   to the container's CSS height. Set this when the consumer wants
   *   blocks to span beyond the visible canvas (e.g. covering the full
   *   document height so they scroll with the page). Does NOT change
   *   canvas intrinsic size — the renderer still draws only into the
   *   viewport-sized canvas.
   * @param {number} [params.fieldWidth] - same idea for the horizontal axis.
   * @param {number} [params.minCountX=8]
   * @param {number} [params.minCountY=8]
   */
  constructor({ container, blockSize, countX, countY, step, fieldHeight, fieldWidth, minCountX, minCountY }) {
    /** @type {HTMLCanvasElement} */
    this.container = container
    /** @type {number} */
    this.blockSize = blockSize
    /** @type {number|undefined} auto-count driver (block+gap target) */
    this.step = step
    /** @type {number|undefined} field dim overrides (see ctor JSDoc) */
    this.fieldHeight = fieldHeight
    this.fieldWidth = fieldWidth
    /** @type {number} */
    this.minCountX = minCountX ?? 8
    /** @type {number} */
    this.minCountY = minCountY ?? 8
    /** @type {number} */
    this.countX = countX ?? this.minCountX
    /** @type {number} */
    this.countY = countY ?? this.minCountY

    /**
     * Fires after recalculate() when countX or countY changed. Set by
     * Grid so it can refresh its public totals and notify consumers
     * (ScrollReveal, gridBridge subscribers) on resize-driven re-tiling.
     * @type {(() => void)|null}
     */
    this._onTopologyChange = null

    /** @type {number} */
    this.gapX = 0
    /** @type {number} */
    this.gapY = 0

    /** @type {number} CSS pixel width */
    this.width = 0
    /** @type {number} CSS pixel height */
    this.height = 0

    /** @type {number} current devicePixelRatio (clamped to 2) */
    const _initialDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    this.dpr = Math.min(_initialDpr, 2)

    /**
     * Flat array of block descriptors. Shape per CLAUDE.md §6.
     * Positions are in CSS pixels — the Renderer handles DPR scaling.
     * @type {Array<{
     *   col: number,
     *   row: number,
     *   x: number,
     *   y: number,
     *   index: number,
     *   distFromCenter: number,
     * }>}
     */
    this.blocks = []

    /** @type {ResizeObserver|null} */
    this._ro = null

    /** @type {MediaQueryList|null} */
    this._dprMql = null

    /** @type {(() => void)|null} */
    this._dprHandler = null

    this.recalculate()
    this._observeResize()
    this._observeDpr()
  }

  /**
   * Recompute container size, gap, and block positions. Also syncs
   * the canvas's intrinsic width/height to its rendered size so
   * pixel coordinates match 1:1.
   *
   * Gap formula (per task spec):
   *   gap = (containerSize - count * blockSize) / (count + 1)
   */
  /**
   * Update grid parameters and recalculate. Any parameter not provided
   * keeps its current value. Returns true if totalBlocks changed
   * (countX or countY was modified), false otherwise.
   *
   * @param {Object} [params]
   * @param {number} [params.blockSize]
   * @param {number} [params.countX]
   * @param {number} [params.countY]
   * @returns {boolean} whether totalBlocks changed
   */
  reconfigure(params = {}) {
    const prevCountX = this.countX
    const prevCountY = this.countY
    if (params.blockSize !== undefined) this.blockSize = params.blockSize
    if (params.countX !== undefined) this.countX = params.countX
    if (params.countY !== undefined) this.countY = params.countY
    if (params.step !== undefined) this.step = params.step
    if (params.fieldHeight !== undefined) this.fieldHeight = params.fieldHeight
    if (params.fieldWidth !== undefined) this.fieldWidth = params.fieldWidth
    this.recalculate({ silent: true })
    return this.countX !== prevCountX || this.countY !== prevCountY
  }

  recalculate(opts = {}) {
    const rect = this.container.getBoundingClientRect()
    this.width = rect.width
    this.height = rect.height
    // DPR clamped to 2 to match prototype behavior — on 3x/4x displays the
    // cost of rendering at native density isn't worth the extra sharpness
    // for a field of 20px blocks, and canvas.width hits backing-store limits
    // on very large viewports.
    const rawDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    this.dpr = Math.min(rawDpr, 2)

    // Canvas intrinsic resolution = CSS size × DPR for sharp rendering
    // on high-density displays. Block positions stay in CSS pixels;
    // the Renderer applies the DPR scale transform before drawing.
    this.container.width = Math.round(this.width * this.dpr)
    this.container.height = Math.round(this.height * this.dpr)

    // When fieldWidth / fieldHeight are provided, use them for block
    // layout (count derivation + gap + block positions). Canvas
    // intrinsic size still follows the container rect above — consumers
    // use this to make blocks span a document-sized area while the
    // canvas stays pinned to the viewport (e.g. blocks scroll with the
    // page through an offsetPosition animation, while the canvas layer
    // stays position:fixed).
    const effW = this.fieldWidth != null ? this.fieldWidth : this.width
    const effH = this.fieldHeight != null ? this.fieldHeight : this.height

    // Step-driven auto count: derive counts from field dims so a window
    // resize keeps block+gap density roughly constant instead of letting
    // gaps explode (or go negative on narrow viewports).
    const prevCountX = this.countX
    const prevCountY = this.countY
    if (this.step && this.step > 0) {
      const derivedX = Math.max(this.minCountX, Math.floor(effW / this.step))
      const derivedY = Math.max(this.minCountY, Math.floor(effH / this.step))
      this.countX = derivedX
      this.countY = derivedY
    }
    const topologyChanged =
      this.countX !== prevCountX || this.countY !== prevCountY

    this.gapX = (effW - this.countX * this.blockSize) / (this.countX + 1)
    this.gapY = (effH - this.countY * this.blockSize) / (this.countY + 1)

    const centerCol = (this.countX - 1) / 2
    const centerRow = (this.countY - 1) / 2
    const maxDist = Math.sqrt(centerCol * centerCol + centerRow * centerRow)

    const blocks = new Array(this.countX * this.countY)
    let i = 0
    for (let row = 0; row < this.countY; row++) {
      for (let col = 0; col < this.countX; col++) {
        const x = this.gapX + col * (this.blockSize + this.gapX)
        const y = this.gapY + row * (this.blockSize + this.gapY)

        const dx = col - centerCol
        const dy = row - centerRow
        const dist = Math.sqrt(dx * dx + dy * dy)
        const distFromCenter = maxDist > 0 ? dist / maxDist : 0

        blocks[i] = {
          col,
          row,
          x,
          y,
          index: i,
          distFromCenter,
        }
        i++
      }
    }
    this.blocks = blocks

    // Notify Grid of topology change driven by ResizeObserver / DPR
    // events. `silent` is set by reconfigure() which routes the
    // notification through Grid.reconfigure() instead.
    if (topologyChanged && !opts.silent && typeof this._onTopologyChange === 'function') {
      this._onTopologyChange()
    }
  }

  /**
   * @returns {number} total number of blocks (countX * countY)
   */
  getTotalBlocks() {
    return this.countX * this.countY
  }

  /**
   * Stop observing resize and DPR changes. Call when grid is torn down.
   */
  destroy() {
    if (this._ro) {
      this._ro.disconnect()
      this._ro = null
    }
    if (this._dprMql && this._dprHandler) {
      this._dprMql.removeEventListener('change', this._dprHandler)
      this._dprMql = null
      this._dprHandler = null
    }
  }

  /**
   * @private
   */
  _observeResize() {
    if (typeof ResizeObserver === 'undefined') return
    this._ro = new ResizeObserver(() => this.recalculate())
    this._ro.observe(this.container)
  }

  /**
   * Watch for devicePixelRatio changes (e.g. moving the window to a
   * monitor with different scaling, or the user changing OS display
   * scaling). Uses matchMedia with a query that matches the current
   * DPR — when it stops matching, DPR has changed.
   * @private
   */
  _observeDpr() {
    if (typeof window === 'undefined' || typeof matchMedia === 'undefined') return

    const subscribe = () => {
      // Clean up previous listener if any
      if (this._dprMql && this._dprHandler) {
        this._dprMql.removeEventListener('change', this._dprHandler)
      }

      const dpr = window.devicePixelRatio || 1
      this._dprMql = matchMedia(`(resolution: ${dpr}dppx)`)
      this._dprHandler = () => {
        this.recalculate()
        // Re-subscribe with the new DPR value
        subscribe()
      }
      this._dprMql.addEventListener('change', this._dprHandler)
    }

    subscribe()
  }
}
