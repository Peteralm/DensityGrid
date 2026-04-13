/**
 * Scroll-driven row reveal animation.
 *
 * When enabled, all blocks start invisible. As rows scroll into the
 * viewport, they reveal with a left-to-right staggered animation:
 * each block slides in from the right and fades in, with a small
 * delay between columns creating a wave effect.
 *
 * Values derived from prototype.html visual specification:
 *   - staggerDelay: 6ms between columns
 *   - riseDuration: 35ms per block
 *   - slideRatio: 0.55 × step (blockSize + gap) horizontal offset
 *   - Easing: smoothstep (Hermite cubic)
 *
 * Total row reveal duration: (countX - 1) × staggerDelay + riseDuration
 * For an 80-column grid: (79 × 6) + 35 = 509ms
 */
export class ScrollReveal {
  /**
   * @param {import('./Grid.js').Grid} grid
   * @param {Object} [options]
   * @param {number} [options.staggerDelay=6] - ms delay between columns
   * @param {number} [options.riseDuration=35] - ms per block fade/slide
   * @param {number} [options.slideRatio=0.55] - horizontal slide as factor of step
   * @param {number} [options.rowStagger=30] - ms delay between rows entering on the same frame
   * @param {() => number} [options.getScrollY] - optional callback returning the current
   *   scroll offset (in px) to subtract from each block's document-space Y before
   *   testing viewport visibility. Required when the canvas is position:fixed and blocks
   *   live in document coordinates (fieldHeight mode). Omit for normal scrolling canvases.
   */
  constructor(grid, options = {}) {
    this._grid = grid
    this._layout = grid._layout
    this._staggerDelay = options.staggerDelay ?? 6
    this._riseDuration = options.riseDuration ?? 35
    this._slideRatio = options.slideRatio ?? 0.55
    this._rowStagger = options.rowStagger ?? 30
    /** @type {(() => number)|null} */
    this._getScrollY = options.getScrollY ?? null

    /** @type {Map<number, {seen:boolean, enteredAt:number, reveal:number, startCol:number}>} */
    this._rowMeta = new Map()
    /** @type {number} */
    this._lastFrameTime = -1
    /** @type {boolean} */
    this._allRevealed = false
    /**
     * True until the first _updateVisibility call completes. On the
     * very first frame, rows already in the viewport are pre-revealed
     * (enteredAt = time - totalDuration) so they appear at full opacity
     * immediately instead of flashing in from zero.
     * @type {boolean}
     */
    this._firstFrame = true

    this._initRows()

    this._controller = grid.registerAnimation('scroll-reveal', (block, time) => {
      return this._evaluate(block, time)
    })
    this._controller.play()
  }

  /** @private */
  _initRows() {
    this._rowMeta.clear()
    for (let row = 0; row < this._layout.countY; row++) {
      this._rowMeta.set(row, {
        seen: false,
        enteredAt: 0,
        reveal: 0,
        startCol: 0,
      })
    }
  }

  /**
   * Per-block evaluation. Called by the animation stack every frame
   * for every block. Returns opacity and position offsets that make
   * unseen blocks invisible and animate them in when their row
   * enters the viewport.
   *
   * @param {Object} block
   * @param {number} time - local animation time (ms)
   * @returns {Object|null}
   * @private
   */
  _evaluate(block, time) {
    if (this._allRevealed) return null

    // Update row visibility once per frame (not per block).
    if (this._lastFrameTime !== time) {
      this._lastFrameTime = time
      this._updateVisibility(time)
    }

    const meta = this._rowMeta.get(block.row)
    if (!meta || !meta.seen) {
      return { opacityOffset: -1 }
    }

    // Per-block stagger timing.
    const colOffset = block.col - meta.startCol
    const blockElapsed = time - meta.enteredAt - colOffset * this._staggerDelay
    const progress = smoothstep(0, this._riseDuration, blockElapsed)

    // Fully revealed — no contribution needed, base state is correct.
    if (progress >= 1) return null

    const step = this._layout.blockSize + this._layout.gapX

    return {
      opacityOffset: -(1 - progress),
      offsetPosition: {
        x: (1 - progress) * step * this._slideRatio,
        y: 0,
      },
    }
  }

  /**
   * Check which rows are now in the viewport and update reveal
   * progress for animating rows. Called once per frame.
   *
   * @param {number} time - local animation time (ms)
   * @private
   */
  _updateVisibility(time) {
    let unseenCount = 0
    let animatingCount = 0

    const rect = this._layout.container.getBoundingClientRect()
    const vh = typeof window !== 'undefined' ? window.innerHeight : 0
    const totalDuration = Math.max(
      1,
      (this._layout.countX - 1) * this._staggerDelay + this._riseDuration,
    )
    // Scroll offset for fixed-canvas / document-space grids. When the
    // canvas is position:fixed and blocks span fieldHeight, rect.top is
    // always 0 — screenY = rect.top + blockY = blockY, which never
    // changes with scroll. Subtracting getScrollY() converts blockY from
    // document space to viewport space so the visibility check is correct.
    const scrollY = this._getScrollY ? this._getScrollY() : 0

    const isFirstFrame = this._firstFrame
    this._firstFrame = false

    // Collect rows entering this frame so we can apply row stagger.
    // Each entry is { meta, immediate } where immediate=true means the
    // row was already visible when ScrollReveal was first created.
    const entering = []

    for (const [row, meta] of this._rowMeta) {
      if (!meta.seen) {
        // Compute row screen position from layout gap + step.
        const blockY =
          this._layout.gapY +
          row * (this._layout.blockSize + this._layout.gapY)
        const screenY = rect.top + blockY - scrollY

        if (
          screenY + this._layout.blockSize >= 0 &&
          screenY <= vh
        ) {
          entering.push({ meta, immediate: isFirstFrame })
          meta.seen = true
          meta.startCol = 0
        } else {
          unseenCount++
          continue
        }
      }

      if (meta.reveal < 1) {
        meta.reveal = Math.min(
          (time - meta.enteredAt) / totalDuration,
          1,
        )
        if (meta.reveal < 1) animatingCount++
      }
    }

    // Apply row stagger: when multiple rows enter on the same frame,
    // offset each successive row's enteredAt so they cascade top→bottom.
    // Exception: rows visible on the very first frame are pre-revealed
    // (enteredAt wound back by totalDuration) so they appear at full
    // opacity immediately with no flash.
    for (let i = 0; i < entering.length; i++) {
      const { meta, immediate } = entering[i]
      if (immediate) {
        meta.enteredAt = time - totalDuration
        meta.reveal = 1
      } else {
        meta.enteredAt = time + i * this._rowStagger
      }
    }

    this._allRevealed = unseenCount === 0 && animatingCount === 0
  }

  /**
   * Called by Grid.reconfigure() when totalBlocks changed (countX or
   * countY was modified). Reinitializes row metadata for the new row
   * count while preserving reveal state for rows that still exist.
   * New rows start unseen and will reveal on scroll. The animation
   * controller is untouched — it keeps running with its current time.
   */
  _onLayoutChange() {
    const oldMeta = this._rowMeta
    this._rowMeta = new Map()
    this._allRevealed = false
    // New rows that are already in the viewport (e.g. rows that appear
    // when the grid widens on resize) should not flash in. Reset
    // _firstFrame so _updateVisibility pre-reveals them on the next tick.
    this._firstFrame = true

    for (let row = 0; row < this._layout.countY; row++) {
      const existing = oldMeta.get(row)
      if (existing && existing.seen) {
        this._rowMeta.set(row, existing)
      } else {
        this._rowMeta.set(row, {
          seen: false,
          enteredAt: 0,
          reveal: 0,
          startCol: 0,
        })
      }
    }
  }

  /**
   * Cancel the animation and clean up.
   */
  destroy() {
    if (this._controller) {
      this._controller.cancel()
      this._controller = null
    }
  }
}

/**
 * Hermite cubic interpolation (standard smoothstep).
 * t = clamp((x - a) / (b - a), 0, 1) → t² × (3 - 2t)
 *
 * @param {number} a - lower edge
 * @param {number} b - upper edge
 * @param {number} x - input value
 * @returns {number} 0..1
 */
function smoothstep(a, b, x) {
  if (b <= a) return x >= b ? 1 : 0
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
