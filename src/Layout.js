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
   * @param {number} [params.minCountX=8]
   * @param {number} [params.minCountY=8]
   */
  constructor({ container, blockSize, countX, countY, step, minCountX, minCountY }) {
    /** @type {HTMLCanvasElement} */
    this.container = container
    /** @type {number} */
    this.blockSize = blockSize
    /** @type {number|undefined} auto-count driver (block+gap target) */
    this.step = step
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

    /** @type {number} current devicePixelRatio */
    this.dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1

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
    this.recalculate({ silent: true })
    return this.countX !== prevCountX || this.countY !== prevCountY
  }

  recalculate(opts = {}) {
    const rect = this.container.getBoundingClientRect()
    this.width = rect.width
    this.height = rect.height
    this.dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1

    // Canvas intrinsic resolution = CSS size × DPR for sharp rendering
    // on high-density displays. Block positions stay in CSS pixels;
    // the Renderer applies the DPR scale transform before drawing.
    this.container.width = Math.round(this.width * this.dpr)
    this.container.height = Math.round(this.height * this.dpr)

    // Step-driven auto count: derive counts from container so a window
    // resize keeps block+gap density roughly constant instead of letting
    // gaps explode (or go negative on narrow viewports).
    const prevCountX = this.countX
    const prevCountY = this.countY
    if (this.step && this.step > 0) {
      const derivedX = Math.max(this.minCountX, Math.floor(this.width / this.step))
      const derivedY = Math.max(this.minCountY, Math.floor(this.height / this.step))
      this.countX = derivedX
      this.countY = derivedY
    }
    const topologyChanged =
      this.countX !== prevCountX || this.countY !== prevCountY

    this.gapX = (this.width - this.countX * this.blockSize) / (this.countX + 1)
    this.gapY = (this.height - this.countY * this.blockSize) / (this.countY + 1)

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
