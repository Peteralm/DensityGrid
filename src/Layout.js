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
   * @param {number} params.countX
   * @param {number} params.countY
   */
  constructor({ container, blockSize, countX, countY }) {
    /** @type {HTMLCanvasElement} */
    this.container = container
    /** @type {number} */
    this.blockSize = blockSize
    /** @type {number} */
    this.countX = countX
    /** @type {number} */
    this.countY = countY

    /** @type {number} */
    this.gapX = 0
    /** @type {number} */
    this.gapY = 0

    /** @type {number} */
    this.width = 0
    /** @type {number} */
    this.height = 0

    /**
     * Flat array of block descriptors. Shape per CLAUDE.md §6.
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

    this.recalculate()
    this._observeResize()
  }

  /**
   * Recompute container size, gap, and block positions. Also syncs
   * the canvas's intrinsic width/height to its rendered size so
   * pixel coordinates match 1:1.
   *
   * Gap formula (per task spec):
   *   gap = (containerSize - count * blockSize) / (count + 1)
   */
  recalculate() {
    const rect = this.container.getBoundingClientRect()
    this.width = rect.width
    this.height = rect.height

    // Keep canvas internal resolution in sync with rendered size.
    // No DPR handling — logical pixels only.
    this.container.width = Math.floor(this.width)
    this.container.height = Math.floor(this.height)

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
  }

  /**
   * @returns {number} total number of blocks (countX * countY)
   */
  getTotalBlocks() {
    return this.countX * this.countY
  }

  /**
   * Stop observing resize. Call when grid is torn down.
   */
  destroy() {
    if (this._ro) {
      this._ro.disconnect()
      this._ro = null
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
}
