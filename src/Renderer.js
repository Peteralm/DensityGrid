/**
 * The rasteriser: ONE instanced draw call per plane, on WebGL2.
 *
 * WHY THIS EXISTS. A cell can be displaced and TURNED, per cell, and the
 * canvas backends cannot express that at any price. Measured, on a page of
 * 24,786 cells: `setTransform` + `roundRect` per cell costs 89.9ms a frame,
 * `setTransform` + `fillRect` 33.6ms, a pre-rotated sprite atlas 48.3ms, and
 * one div per cell 67.8ms — the last one because it is the same Skia
 * rasteriser on the same thread, which is also why "let the compositor do it"
 * does not survive contact with 25k elements. The same field through this
 * path costs 0.24ms, against 0.21ms for the old two-blit path that could not
 * rotate anything. Per-cell transform is FREE here; what costs is framebuffer
 * pixels, which is a different budget and one the viewport window controls.
 *
 * The corner is a signed distance field in the fragment shader, so it is exact
 * at any angle and antialiased by `fwidth` — no mask strip to rasterise on
 * resize, no atlas to quantise the angle, and the corner stops being a
 * per-cell rasterisation at all. That corner was the entire bill of the old
 * per-cell walk: painting the same cells square took a 45.7ms frame to 4.2ms.
 *
 * PREMULTIPLICATION, both halves. The context is premultiplied (the default)
 * AND the shader emits `rgb * a`, blending `ONE, ONE_MINUS_SRC_ALPHA`.
 * Declaring the context unpremultiplied while blending with `SRC_ALPHA`
 * writes a premultiplied buffer that the compositor divides a second time:
 * every cell comes out dark by its own alpha, measured as a 30% loss of ink
 * against the canvas reference.
 *
 * ONE CONTEXT PER PLANE. Contexts cannot share programs or buffers, so each
 * plane carries its own — three of them, against a browser limit around
 * sixteen. Collapsing to one context with framebuffer targets is possible and
 * is NOT done: it is more machine than the problem currently has.
 */

const VERT = `#version 300 es
layout(location=0) in vec2 corner;   // unit quad, -0.5..0.5
layout(location=1) in vec2 cell;     // gx, gy — per instance
layout(location=2) in vec3 xyr;      // offX, offY, rot — per instance
layout(location=3) in vec4 rgba;     // per instance, normalised from bytes
precision highp float;
uniform vec2 uRes;      // device px
uniform vec2 uOrigin;   // CSS px, BAND-LOCAL: lattice origin minus band top
uniform float uStep;
uniform float uBlock;
uniform float uDpr;
out vec2 vLocal;
out vec4 vColor;
void main(){
  // The quad has to cover the cell's DIAGONAL or a rotated cell is clipped by
  // its own geometry. sqrt(2) plus a hair, so the SDF always has slack.
  float s = uBlock * 1.4143;
  vec2 p = corner * s;
  float c = cos(xyr.z), si = sin(xyr.z);
  p = vec2(p.x * c - p.y * si, p.x * si + p.y * c);
  vec2 centre = uOrigin + cell * uStep + uBlock * 0.5 + xyr.xy;
  vec2 px = (centre + p) * uDpr;
  gl_Position = vec4(px / uRes * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
  // Local coordinates PRE-rotation: the SDF is evaluated in the cell's own
  // frame, which is what keeps the corner exact at every angle.
  vLocal = corner * s;
  vColor = rgba;
}`

// `precision highp float` must be declared in BOTH stages. mediump in one and
// the default in the other fails to link with "Precisions of uniform differ",
// and the uniforms in question are shared by name across the two.
const FRAG = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec4 vColor;
out vec4 o;
uniform float uBlock;
uniform float uRadius;
float sdRound(vec2 p, vec2 b, float r){
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main(){
  float d = sdRound(vLocal, vec2(uBlock * 0.5), uRadius);
  float aa = fwidth(d);
  float cov = 1.0 - smoothstep(-aa, aa, d);
  if (cov <= 0.0) discard;
  float a = vColor.a * cov;
  o = vec4(vColor.rgb * a, a);
}`

export class Renderer {
  /**
   * @param {Object} params
   * @param {HTMLCanvasElement} params.container - the 'base' plane
   * @param {import('./Layout.js').Layout} params.layout
   * @param {import('./Field.js').FieldStack} params.fields
   * @param {number} [params.cornerRadius]
   * @param {Object<string, HTMLCanvasElement>} [params.planes]
   */
  constructor({ container, layout, fields = null, cornerRadius = 0, planes = null }) {
    /** @type {HTMLCanvasElement} */
    this.container = container
    /** @type {import('./Layout.js').Layout} */
    this.layout = layout
    /** @type {import('./Field.js').FieldStack|null} */
    this.fields = fields
    /** @type {number} block corner radius in CSS px (0 = square) */
    this.cornerRadius = cornerRadius

    /** @type {Array<Object>} raster targets, drawn in array order */
    this.planes = [this._makePlane('base', container)]
    if (planes) {
      for (const name in planes) {
        const canvas = planes[name]
        if (!canvas || name === 'base') continue
        this.planes.push(this._makePlane(name, canvas))
      }
    }

    /** @type {number} rAF handle */
    this._rafId = 0
    /** @type {boolean} */
    this._running = false
    this._tick = this._tick.bind(this)
  }

  /**
   * A plane starts INERT and stays that way if WebGL2 is unavailable: the
   * page keeps working, the fabric simply does not paint. There is no canvas
   * fallback — a second rasteriser is a second set of bugs, and the whole
   * point of this renderer is expressing something canvas cannot.
   * @private
   */
  _makePlane(name, canvas) {
    const plane = {
      name,
      canvas,
      /** @type {WebGL2RenderingContext|null} */
      gl: null,
      /** where the canvas sits in the document, CSS px */
      box: null,
      /** true between contextlost and contextrestored */
      lost: false,
      prog: null,
      vao: null,
      buffers: null,
      uniforms: null,
      /** instance capacity the dynamic buffers are allocated for */
      capacity: 0,
      /** CPU staging for the per-instance attributes */
      aCell: null,
      aXyr: null,
      aRgba: null,
    }
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: false })
    if (!gl) return plane
    plane.gl = gl
    this._buildGL(plane)
    return plane
  }

  /**
   * Compile the program and allocate the static quad. Called at construction
   * and again after the context is restored, so it must assume nothing about
   * what survived.
   * @private
   */
  _buildGL(plane) {
    const gl = plane.gl
    if (!gl) return
    const compile = (type, src) => {
      const s = gl.createShader(type)
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s)
        gl.deleteShader(s)
        throw new Error(`densitygrid: shader failed to compile — ${log}`)
      }
      return s
    }
    const prog = gl.createProgram()
    const vs = compile(gl.VERTEX_SHADER, VERT)
    const fs = compile(gl.FRAGMENT_SHADER, FRAG)
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`densitygrid: program failed to link — ${gl.getProgramInfoLog(prog)}`)
    }
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    gl.useProgram(prog)

    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)

    const quad = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    // THE CELL INDEX IS PER-INSTANCE AND DYNAMIC, not static per topology.
    // Only LIVE cells are uploaded — instance i is the i-th cell the fields
    // actually wrote — so which cell an instance carries changes every frame.
    // A static lattice-wide buffer would force every cell to be drawn whether
    // it was written or not, which is affordable on the GPU but throws away
    // the one filter that makes the viewport window cheap.
    const bCell = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, bCell)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0)
    gl.vertexAttribDivisor(1, 1)

    const bXyr = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, bXyr)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0)
    gl.vertexAttribDivisor(2, 1)

    const bRgba = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, bRgba)
    gl.enableVertexAttribArray(3)
    // Normalised unsigned bytes: 4 bytes per cell, RGBA8, always.
    gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, 0, 0)
    gl.vertexAttribDivisor(3, 1)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.clearColor(0, 0, 0, 0)

    plane.prog = prog
    plane.vao = vao
    plane.buffers = { quad, cell: bCell, xyr: bXyr, rgba: bRgba }
    plane.uniforms = {
      uRes: gl.getUniformLocation(prog, 'uRes'),
      uOrigin: gl.getUniformLocation(prog, 'uOrigin'),
      uStep: gl.getUniformLocation(prog, 'uStep'),
      uBlock: gl.getUniformLocation(prog, 'uBlock'),
      uDpr: gl.getUniformLocation(prog, 'uDpr'),
      uRadius: gl.getUniformLocation(prog, 'uRadius'),
    }
    plane.capacity = 0
  }

  /**
   * Grow the per-instance buffers to hold `n` cells. Capacity only ever
   * grows: a frame that lights fewer cells than the last one reuses the
   * allocation rather than reallocating down and back up as content moves.
   * @private
   */
  _ensureCapacity(plane, n) {
    if (n <= plane.capacity) return
    const gl = plane.gl
    // Round up so a field that grows by one cell a frame does not reallocate
    // every frame.
    const cap = Math.max(1024, 1 << Math.ceil(Math.log2(n)))
    plane.capacity = cap
    plane.aCell = new Float32Array(cap * 2)
    plane.aXyr = new Float32Array(cap * 3)
    plane.aRgba = new Uint8Array(cap * 4)
    gl.bindVertexArray(plane.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, plane.buffers.cell)
    gl.bufferData(gl.ARRAY_BUFFER, plane.aCell.byteLength, gl.DYNAMIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, plane.buffers.xyr)
    gl.bufferData(gl.ARRAY_BUFFER, plane.aXyr.byteLength, gl.DYNAMIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, plane.buffers.rgba)
    gl.bufferData(gl.ARRAY_BUFFER, plane.aRgba.byteLength, gl.DYNAMIC_DRAW)
  }

  /**
   * Where a plane's canvas sits in the document, in CSS px.
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
   * HERE: <canvas> is a REPLACED element, so with no CSS size its CSS box IS
   * its intrinsic size. If a band were ever derived from a measurement of the
   * canvas itself, this write would grow it by `dpr` on every pass until the
   * cell count melts the frame — silently, with nothing in the console
   * pointing at CSS. It is safe only because a band comes from the SECTION the
   * plane serves, never from the plane.
   * @private
   */
  _sizePlane(plane) {
    if (!plane.gl || !plane.box) return
    const layout = this.layout
    const dpr = layout.dpr
    const w = Math.max(1, Math.round(layout.fieldWidth * dpr))
    const h = Math.max(1, Math.round(plane.box.height * dpr))
    if (plane.canvas.width !== w || plane.canvas.height !== h) {
      plane.canvas.width = w
      plane.canvas.height = h
    }
  }

  /** @private */
  _ensureBox(plane) {
    if (!plane.box) {
      const rect = plane.canvas.getBoundingClientRect()
      plane.box = { top: 0, height: rect.height || this.layout.fieldHeight }
    }
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

  /** @private */
  _tick(now) {
    if (!this._running) return
    this._draw(now)
    this._rafId = requestAnimationFrame(this._tick)
  }

  /**
   * Compose and draw one frame, per plane.
   *
   * @param {number} now
   * @private
   */
  _draw(now) {
    const layout = this.layout
    if (!this.fields) return
    const cols = layout.countX
    const rows = layout.countY
    if (cols <= 0 || rows <= 0) return

    for (let p = 0; p < this.planes.length; p++) {
      const plane = this.planes[p]
      const gl = plane.gl
      if (!gl || plane.lost) continue
      const box = this._ensureBox(plane)
      if (!(box.height > 0)) continue

      this.fields.compose(cols, rows, now, plane.name)
      const n = this._pack(plane)

      gl.viewport(0, 0, plane.canvas.width, plane.canvas.height)
      gl.clear(gl.COLOR_BUFFER_BIT)
      if (n === 0) continue

      gl.useProgram(plane.prog)
      gl.bindVertexArray(plane.vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, plane.buffers.cell)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, plane.aCell, 0, n * 2)
      gl.bindBuffer(gl.ARRAY_BUFFER, plane.buffers.xyr)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, plane.aXyr, 0, n * 3)
      gl.bindBuffer(gl.ARRAY_BUFFER, plane.buffers.rgba)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, plane.aRgba, 0, n * 4)

      const u = plane.uniforms
      gl.uniform2f(u.uRes, plane.canvas.width, plane.canvas.height)
      // The lattice is document space and this canvas is a band of it, so the
      // origin is written band-local. There is no scroll term here — that is
      // the point of the arrangement.
      gl.uniform2f(u.uOrigin, layout.originX, layout.originY - box.top)
      gl.uniform1f(u.uStep, layout.step_)
      gl.uniform1f(u.uBlock, layout.blockSize)
      gl.uniform1f(u.uDpr, layout.dpr)
      gl.uniform1f(u.uRadius, this.cornerRadius)

      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n)
    }
  }

  /**
   * Copy the composed cells into the per-instance staging arrays.
   *
   * This is the only per-cell CPU work left in the renderer, and it is a flat
   * copy — no decision, no path, no rasterisation.
   *
   * @private
   * @returns {number} instance count
   */
  _pack(plane) {
    const stack = this.fields
    let n = 0
    // Count first so the buffers are sized once. `_dirtyCount` is the exact
    // number of cells the compose pass touched.
    this._ensureCapacity(plane, stack._dirtyCount || 1)
    const aCell = plane.aCell
    const aXyr = plane.aXyr
    const aRgba = plane.aRgba
    stack.forEachCell((gx, gy, alpha, color, offX, offY, rot) => {
      if (!(alpha > 0)) return
      const i2 = n * 2
      const i3 = n * 3
      const i4 = n * 4
      aCell[i2] = gx
      aCell[i2 + 1] = gy
      aXyr[i3] = offX
      aXyr[i3 + 1] = offY
      aXyr[i3 + 2] = rot
      aRgba[i4] = (color >> 16) & 0xff
      aRgba[i4 + 1] = (color >> 8) & 0xff
      aRgba[i4 + 2] = color & 0xff
      aRgba[i4 + 3] = alpha >= 1 ? 255 : (alpha * 255 + 0.5) | 0
      n++
    })
    return n
  }
}
