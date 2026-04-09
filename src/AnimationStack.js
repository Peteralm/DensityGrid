/**
 * Manages the list of active animation controllers.
 * Every frame, sums their offsets per block into a single result.
 *
 * Priority rules (CLAUDE.md §6):
 *   - offsetOpacity / offsetPosition → summed across all contributing
 *     controllers.
 *   - absoluteOpacity / absolutePosition → last writer wins (stack
 *     registration order; a later-registered animation overrides an
 *     earlier one's absolute).
 *   - "offset wins over absolute" is resolved by the Renderer: if
 *     the summed offset is non-zero, it takes precedence over any
 *     absolute value. The stack simply reports both.
 *
 * Self-cancel safety:
 *   Controllers flip their own status to ENDED on cancel() but do
 *   not mutate this array. The evaluate loop skips ENDED in place.
 *   Dead entries are compacted lazily in add() to keep the array
 *   bounded over long sessions.
 *
 * Scratch allocation:
 *   evaluate() is called once per block per frame — at 3600 blocks
 *   and 60fps that's ~216k calls per second. We reuse a single
 *   result object instead of allocating per call. Callers must
 *   read values immediately and not retain the returned reference.
 */
export class AnimationStack {
  constructor() {
    /** @type {import('./AnimationController.js').AnimationController[]} */
    this.controllers = []

    /**
     * Debug filter — when non-null, only controllers whose names
     * are in this set contribute to the summed output. Others
     * still have their fn called every frame (time advances, cache
     * updates) but their output is discarded.
     * @type {Set<string>|null}
     */
    this.filter = null

    /**
     * Controller whose fn is currently executing. Used by
     * getCurrent() so fns can self-reference without needing a
     * captured closure variable. Save/restored across nested
     * calls just in case.
     * @type {import('./AnimationController.js').AnimationController|null}
     */
    this._current = null

    /**
     * Pooled return object for evaluate(). Reused per call.
     * @type {{
     *   opacityOffset: number,
     *   absoluteOpacity: number|null,
     *   offsetPosition: { x: number, y: number },
     *   absolutePosition: { x: number, y: number }|null,
     * }}
     */
    this._result = {
      opacityOffset: 0,
      absoluteOpacity: null,
      offsetPosition: { x: 0, y: 0 },
      absolutePosition: null,
    }
  }

  /**
   * @param {import('./AnimationController.js').AnimationController} controller
   */
  add(controller) {
    // Compact dead (ENDED) entries opportunistically. Cheap and
    // keeps the iteration short over long sessions.
    this._compact()
    this.controllers.push(controller)
  }

  /**
   * Public removal. Do not call from inside the evaluate loop —
   * controllers self-cancel by setting status=ENDED, which the
   * loop handles safely without splicing.
   *
   * @param {import('./AnimationController.js').AnimationController} controller
   */
  remove(controller) {
    const idx = this.controllers.indexOf(controller)
    if (idx >= 0) this.controllers.splice(idx, 1)
  }

  /**
   * @returns {import('./AnimationController.js').AnimationController|null}
   *   The controller whose fn is currently executing, or null.
   */
  getCurrent() {
    return this._current
  }

  /**
   * Per-frame: evaluate every live controller for a single block
   * and return the summed offsets. Returns a pooled object — read
   * immediately, do not retain.
   *
   * @param {Object} block
   * @param {number} now - rAF timestamp
   * @returns {{
   *   opacityOffset: number,
   *   absoluteOpacity: number|null,
   *   offsetPosition: { x: number, y: number },
   *   absolutePosition: { x: number, y: number }|null,
   * }}
   */
  evaluate(block, now) {
    const result = this._result
    result.opacityOffset = 0
    result.absoluteOpacity = null
    result.offsetPosition.x = 0
    result.offsetPosition.y = 0
    result.absolutePosition = null

    const filter = this.filter
    const list = this.controllers

    for (let i = 0; i < list.length; i++) {
      const ctrl = list[i]
      const status = ctrl.status

      // IDLE: not started yet. ENDED: cancelled. Neither contributes.
      if (status === 'IDLE' || status === 'ENDED') continue

      // Track current so fns can call getCurrent() if they want.
      const prevCurrent = this._current
      this._current = ctrl
      const out = ctrl._evaluate(block, now)
      this._current = prevCurrent

      if (!out) continue

      // Filter contract: fn is still called above (time still
      // advances, PAUSE cache still fills), but the output is
      // excluded from the summed result.
      if (filter && !filter.has(ctrl.name)) continue

      if (typeof out.opacityOffset === 'number') {
        result.opacityOffset += out.opacityOffset
      }
      if (typeof out.absoluteOpacity === 'number') {
        // Last-wins by stack order.
        result.absoluteOpacity = out.absoluteOpacity
      }
      if (out.offsetPosition) {
        if (typeof out.offsetPosition.x === 'number') {
          result.offsetPosition.x += out.offsetPosition.x
        }
        if (typeof out.offsetPosition.y === 'number') {
          result.offsetPosition.y += out.offsetPosition.y
        }
      }
      if (out.absolutePosition) {
        // Last-wins by stack order.
        result.absolutePosition = out.absolutePosition
      }
    }

    return result
  }

  /**
   * Debug listing of live controllers. ENDED entries are excluded.
   *
   * @returns {Array<{ name: string, status: string }>}
   */
  list() {
    const out = []
    for (let i = 0; i < this.controllers.length; i++) {
      const ctrl = this.controllers[i]
      if (ctrl.status === 'ENDED') continue
      out.push({ name: ctrl.name, status: ctrl.status })
    }
    return out
  }

  /**
   * Restrict which animations contribute to the summed output.
   * Pass null or an empty array to clear.
   *
   * @param {string[]|null} names
   */
  setFilter(names) {
    if (!names || names.length === 0) {
      this.filter = null
      return
    }
    this.filter = new Set(names)
  }

  /**
   * @private
   * Remove ENDED controllers from the array.
   */
  _compact() {
    for (let i = this.controllers.length - 1; i >= 0; i--) {
      if (this.controllers[i].status === 'ENDED') {
        this.controllers.splice(i, 1)
      }
    }
  }
}
