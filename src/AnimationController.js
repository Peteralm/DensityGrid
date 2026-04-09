/**
 * Lifecycle states for a controller.
 * @typedef {'IDLE'|'RUNNING'|'PAUSED'|'ENDED'} AnimationStatus
 */

/**
 * Individual animation controller. Wraps a single animation function
 * and exposes play / pause / cancel / onEnded.
 *
 * Lifecycle (CLAUDE.md §6):
 *   IDLE → play() → RUNNING ↔ pause() → PAUSED
 *                                │
 *                            cancel() → ENDED → onEnded fires
 *
 * Time model:
 *   Each controller has its own local time that starts at 0 on the
 *   first play() call and advances with the wall clock while
 *   RUNNING. pause() freezes the local time. A subsequent play()
 *   resumes from that frozen value (local time is monotonic across
 *   a RUNNING → PAUSED → RUNNING cycle).
 *
 * PAUSED output caching:
 *   "last output stays in offset sum as fixed value" is per-block —
 *   each block had its own return value. While PAUSED, _evaluate
 *   returns the cached output for the requested block and does NOT
 *   call the user fn.
 *
 * Self-cancel from inside the fn:
 *   cancel() only flips status to ENDED and fires onEnded callbacks.
 *   It does NOT mutate the stack's array. The stack's iteration
 *   checks status and skips ENDED entries; the array is compacted
 *   lazily on the next add(). This makes `ctrl.cancel()` safe to
 *   call from inside the animation function.
 */
export class AnimationController {
  /**
   * @param {Object} params
   * @param {string} params.name
   * @param {(block: Object, time: number) => Object} params.fn
   * @param {import('./AnimationStack.js').AnimationStack} params.stack
   */
  constructor({ name, fn, stack }) {
    /** @type {string} */
    this.name = name
    /** @type {(block: Object, time: number) => Object} */
    this.fn = fn
    /** @type {AnimationStatus} */
    this.status = 'IDLE'

    /** @type {import('./AnimationStack.js').AnimationStack} */
    this._stack = stack

    /** @type {Array<() => void>} */
    this._endedCallbacks = []

    /**
     * Wall-clock offset: local time = wall time - _wallOffset.
     * Recomputed on every play() so that local time resumes from
     * _frozenTime.
     * @type {number}
     */
    this._wallOffset = 0

    /**
     * Local time at the moment of the last evaluate. When PAUSED,
     * this is the frozen value and is used to re-anchor wall time
     * on the next play().
     * @type {number}
     */
    this._frozenTime = 0

    /**
     * When true, the next _evaluate will (re)initialize _wallOffset
     * using the incoming `now`. Set by play(), cleared by _evaluate.
     * We defer the wall-time anchor to the first frame so the local
     * clock is aligned with the rAF clock the renderer uses.
     * @type {boolean}
     */
    this._pendingStart = false

    /**
     * Per-block cache of the last output returned by fn. Used while
     * PAUSED. Keyed by block.index (stable within a layout).
     * @type {Map<number, Object>}
     */
    this._lastOutputByBlock = new Map()

    // Controllers are in the stack from birth. Play/pause only
    // change status; cancel flips to ENDED (lazy removal via
    // stack._compact()).
    stack.add(this)
  }

  play() {
    if (this.status === 'ENDED') return
    if (this.status === 'RUNNING') return
    // IDLE or PAUSED → RUNNING. _frozenTime stays as-is so the
    // local clock picks up where it left off (0 if this is the
    // first play).
    this._pendingStart = true
    this.status = 'RUNNING'
  }

  pause() {
    if (this.status !== 'RUNNING') return
    // _frozenTime was updated inside the last _evaluate call, so
    // it already reflects the correct local time to freeze at.
    this.status = 'PAUSED'
  }

  cancel() {
    if (this.status === 'ENDED') return
    this.status = 'ENDED'

    // Snapshot callbacks and clear the list so re-entrant onEnded()
    // calls during a callback don't re-fire existing ones.
    const cbs = this._endedCallbacks
    this._endedCallbacks = []
    for (let i = 0; i < cbs.length; i++) {
      try {
        cbs[i]()
      } catch (_) {
        // Swallow: one bad callback shouldn't block the others.
      }
    }

    // Drop the per-block cache — not needed anymore, and holding
    // it pins potentially large closures in memory.
    this._lastOutputByBlock.clear()
  }

  /**
   * Register a callback fired when the animation reaches ENDED.
   * Fires synchronously if the controller is already ENDED.
   *
   * @param {() => void} cb
   */
  onEnded(cb) {
    if (typeof cb !== 'function') return
    if (this.status === 'ENDED') {
      try {
        cb()
      } catch (_) {}
      return
    }
    this._endedCallbacks.push(cb)
  }

  /**
   * Internal — compute the offset contribution for a single block
   * on the current frame.
   *
   * Called by AnimationStack.evaluate. Returns null for statuses
   * that contribute nothing (IDLE, ENDED, or PAUSED with no cached
   * output for this block).
   *
   * If the user fn calls `this.cancel()`, status flips to ENDED
   * mid-call; we detect that on return and drop the output.
   *
   * @param {Object} block
   * @param {number} now - rAF timestamp in ms
   * @returns {Object|null}
   */
  _evaluate(block, now) {
    const status = this.status

    if (status === 'IDLE' || status === 'ENDED') return null

    if (status === 'PAUSED') {
      const cached = this._lastOutputByBlock.get(block.index)
      return cached || null
    }

    // RUNNING
    if (this._pendingStart) {
      // Anchor wall time so that local time = _frozenTime right
      // now. On first play _frozenTime is 0, so local time starts
      // at 0. On resume from PAUSED, local time picks up where it
      // was frozen.
      this._wallOffset = now - this._frozenTime
      this._pendingStart = false
    }

    const time = now - this._wallOffset
    this._frozenTime = time

    const out = this.fn(block, time)

    // fn may have called this.cancel() — if so, don't contribute
    // and don't cache.
    if (this.status === 'ENDED') return null

    if (out) {
      this._lastOutputByBlock.set(block.index, out)
    }
    return out || null
  }
}
