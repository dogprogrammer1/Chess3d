/* Single-canvas WebGL scene for the board, coordinates, move markers,
 * and shared low-poly chess meshes. The same scene also owns ray picking. */
/* WebGL board scene and piece meshes. */
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const FILES = 'abcdefgh';
  const PIECE_SCALE = .86;
  const PAWN_SCALE = .88;
  const WHITE = [0.86, 0.82, 0.72];
  const BLACK = [0.055, 0.17, 0.15];
  const LIGHT_TILE = [0.74, 0.65, 0.48];
  const DARK_TILE = [0.16, 0.34, 0.29];
  const WOOD = [0.09, 0.20, 0.18];
  const SELECTED_TILE = [0.76, 0.54, 0.16];
  const CHECK_TILE = [0.58, 0.18, 0.14];
  const LEGAL_MARKER = [0.86, 0.74, 0.43];
  const CAPTURE_MARKER = [0.72, 0.16, 0.11];
  const COORDINATE = [0.89, 0.72, 0.34];
  const GLYPH_SEGMENTS = {
    top: [[-.32,-.5],[.32,-.5]], middle: [[-.32,0],[.32,0]], bottom: [[-.32,.5],[.32,.5]],
    upperLeft: [[-.32,-.5],[-.32,0]], upperRight: [[.32,-.5],[.32,0]],
    lowerLeft: [[-.32,0],[-.32,.5]], lowerRight: [[.32,0],[.32,.5]]
  };
  const GLYPHS = {
    a: ['top','upperLeft','upperRight','middle','lowerLeft','lowerRight'],
    b: ['top','upperLeft','middle','lowerLeft','bottom','upperRight','lowerRight'],
    c: ['top','upperLeft','lowerLeft','bottom'],
    d: ['top','upperLeft','lowerLeft','bottom','upperRight','lowerRight'],
    e: ['top','upperLeft','middle','lowerLeft','bottom'],
    f: ['top','upperLeft','middle','lowerLeft'],
    g: ['top','upperLeft','middle','lowerLeft','lowerRight','bottom'],
    h: ['upperLeft','lowerLeft','middle','upperRight','lowerRight'],
    1: ['upperRight','lowerRight'],
    2: ['top','upperRight','middle','lowerLeft','bottom'],
    3: ['top','upperRight','middle','lowerRight','bottom'],
    4: ['upperLeft','middle','upperRight','lowerRight'],
    5: ['top','upperLeft','middle','lowerRight','bottom'],
    6: ['top','upperLeft','middle','lowerLeft','lowerRight','bottom'],
    7: ['top','upperRight','lowerRight'],
    8: ['top','upperLeft','upperRight','middle','lowerLeft','lowerRight','bottom']
  };

  const vertexSource = `
    attribute vec3 aPosition;
    attribute vec3 aNormal;
    uniform mat4 uProjection;
    uniform mat4 uView;
    uniform mat4 uModel;
    varying vec3 vNormal;
    varying vec3 vWorld;
    void main() {
      vec4 world = uModel * vec4(aPosition, 1.0);
      vWorld = world.xyz;
      vNormal = mat3(uModel) * aNormal;
      gl_Position = uProjection * uView * world;
    }
  `;

  const fragmentSource = `
    precision mediump float;
    uniform vec3 uColor;
    uniform float uShine;
    varying vec3 vNormal;
    varying vec3 vWorld;
    void main() {
      vec3 normal = normalize(vNormal);
      vec3 light = normalize(vec3(-0.55, 0.9, 0.42));
      vec3 view = normalize(vec3(0.0, 7.0, 9.0) - vWorld);
      float diffuse = max(dot(normal, light), 0.0);
      float specular = pow(max(dot(reflect(-light, normal), view), 0.0), 20.0) * uShine;
      vec3 lit = uColor * (0.28 + diffuse * 0.72) + vec3(specular);
      gl_FragColor = vec4(lit, 1.0);
    }
  `;

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  function createProgram(gl) {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    return program;
  }

  function addVertex(data, position, normal) { data.push(...position, ...normal); }
  function addTriangle(data, a, b, c, normal) { addVertex(data, a, normal); addVertex(data, b, normal); addVertex(data, c, normal); }

  function box(width, height, depth) {
    const x = width / 2, y = height / 2, z = depth / 2, data = [];
    const faces = [
      [[[-x,-y,z],[x,-y,z],[x,y,z],[-x,y,z]],[0,0,1]],
      [[[x,-y,-z],[-x,-y,-z],[-x,y,-z],[x,y,-z]],[0,0,-1]],
      [[[-x,y,z],[x,y,z],[x,y,-z],[-x,y,-z]],[0,1,0]],
      [[[-x,-y,-z],[x,-y,-z],[x,-y,z],[-x,-y,z]],[0,-1,0]],
      [[[x,-y,z],[x,-y,-z],[x,y,-z],[x,y,z]],[1,0,0]],
      [[[-x,-y,-z],[-x,-y,z],[-x,y,z],[-x,y,-z]],[-1,0,0]]
    ];
    faces.forEach(([points, normal]) => { addTriangle(data, points[0], points[1], points[2], normal); addTriangle(data, points[0], points[2], points[3], normal); });
    return data;
  }

  function lathe(profile, segments = 16) {
    const data = [];
    for (let ring = 0; ring < profile.length - 1; ring += 1) {
      const [r1, y1] = profile[ring];
      const [r2, y2] = profile[ring + 1];
      const dy = y2 - y1, dr = r2 - r1;
      for (let segment = 0; segment < segments; segment += 1) {
        const a = segment / segments * TAU, b = (segment + 1) / segments * TAU;
        const normal = normalize([Math.cos((a + b) / 2) * dy, -dr, Math.sin((a + b) / 2) * dy]);
        const p1 = [r1 * Math.cos(a), y1, r1 * Math.sin(a)];
        const p2 = [r1 * Math.cos(b), y1, r1 * Math.sin(b)];
        const p3 = [r2 * Math.cos(b), y2, r2 * Math.sin(b)];
        const p4 = [r2 * Math.cos(a), y2, r2 * Math.sin(a)];
        addTriangle(data, p1, p2, p3, normal); addTriangle(data, p1, p3, p4, normal);
      }
    }
    return data;
  }

  function sphere(radius) {
    const profile = [];
    for (let i = 0; i <= 8; i += 1) {
      const phi = -Math.PI / 2 + i / 8 * Math.PI;
      profile.push([Math.cos(phi) * radius, Math.sin(phi) * radius]);
    }
    return lathe(profile, 16);
  }

  function disc(inner, outer = inner, segments = 24) {
    const data = [];
    for (let segment = 0; segment < segments; segment += 1) {
      const a = segment / segments * TAU, b = (segment + 1) / segments * TAU;
      const outerA = [outer * Math.cos(a), 0, outer * Math.sin(a)];
      const outerB = [outer * Math.cos(b), 0, outer * Math.sin(b)];
      if (inner === outer) {
        addTriangle(data, [0,0,0], outerB, outerA, [0,1,0]);
      } else {
        const innerA = [inner * Math.cos(a), 0, inner * Math.sin(a)];
        const innerB = [inner * Math.cos(b), 0, inner * Math.sin(b)];
        addTriangle(data, innerA, outerB, outerA, [0,1,0]);
        addTriangle(data, innerA, innerB, outerB, [0,1,0]);
      }
    }
    return data;
  }

  function extrusion(points, depth) {
    const data = [], z = depth / 2;
    const front = [0, 0, 1], back = [0, 0, -1];
    for (let i = 1; i < points.length - 1; i += 1) {
      addTriangle(data, [points[0][0], points[0][1], z], [points[i][0], points[i][1], z], [points[i + 1][0], points[i + 1][1], z], front);
      addTriangle(data, [points[0][0], points[0][1], -z], [points[i + 1][0], points[i + 1][1], -z], [points[i][0], points[i][1], -z], back);
    }
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i], b = points[(i + 1) % points.length];
      const normal = normalize([b[1] - a[1], -(b[0] - a[0]), 0]);
      const p1 = [a[0], a[1], -z], p2 = [b[0], b[1], -z], p3 = [b[0], b[1], z], p4 = [a[0], a[1], z];
      addTriangle(data, p1, p2, p3, normal); addTriangle(data, p1, p3, p4, normal);
    }
    return data;
  }

  function normalize(vector) {
    const size = Math.hypot(...vector) || 1;
    return vector.map(value => value / size);
  }

  function blend(first, second, amount) { return first.map((value, index) => value + (second[index] - value) * amount); }

  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  function perspective(out, fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
    out.set([f / aspect,0,0,0, 0,f,0,0, 0,0,(far + near) * nf,-1, 0,0,2 * far * near * nf,0]);
  }

  function lookAt(out, eye, target) {
    const z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
    const x = normalize(cross([0, 1, 0], z));
    const y = cross(z, x);
    out.set([x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0, -dot(x, eye),-dot(y, eye),-dot(z, eye),1]);
  }

  function model(out, x, y, z, rotation = 0, scale = 1) {
    const [scaleX, scaleY, scaleZ] = Array.isArray(scale) ? scale : [scale, scale, scale];
    const cosine = Math.cos(rotation), sine = Math.sin(rotation);
    out.set([cosine * scaleX,0,-sine * scaleX,0, 0,scaleY,0,0, sine * scaleZ,0,cosine * scaleZ,0, x,y,z,1]);
  }

  function multiply(out, a, b) {
    for (let column = 0; column < 4; column += 1) for (let row = 0; row < 4; row += 1) {
      out[column * 4 + row] = a[row] * b[column * 4] + a[4 + row] * b[column * 4 + 1] + a[8 + row] * b[column * 4 + 2] + a[12 + row] * b[column * 4 + 3];
    }
  }

  function invert(out, matrix) {
    const m = matrix;
    const b00 = m[0] * m[5] - m[1] * m[4], b01 = m[0] * m[6] - m[2] * m[4], b02 = m[0] * m[7] - m[3] * m[4];
    const b03 = m[1] * m[6] - m[2] * m[5], b04 = m[1] * m[7] - m[3] * m[5], b05 = m[2] * m[7] - m[3] * m[6];
    const b06 = m[8] * m[13] - m[9] * m[12], b07 = m[8] * m[14] - m[10] * m[12], b08 = m[8] * m[15] - m[11] * m[12];
    const b09 = m[9] * m[14] - m[10] * m[13], b10 = m[9] * m[15] - m[11] * m[13], b11 = m[10] * m[15] - m[11] * m[14];
    let determinant = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!determinant) return false;
    determinant = 1 / determinant;
    out[0] = (m[5] * b11 - m[6] * b10 + m[7] * b09) * determinant;
    out[1] = (m[2] * b10 - m[1] * b11 - m[3] * b09) * determinant;
    out[2] = (m[13] * b05 - m[14] * b04 + m[15] * b03) * determinant;
    out[3] = (m[10] * b04 - m[9] * b05 - m[11] * b03) * determinant;
    out[4] = (m[6] * b08 - m[4] * b11 - m[7] * b07) * determinant;
    out[5] = (m[0] * b11 - m[2] * b08 + m[3] * b07) * determinant;
    out[6] = (m[14] * b02 - m[12] * b05 - m[15] * b01) * determinant;
    out[7] = (m[8] * b05 - m[10] * b02 + m[11] * b01) * determinant;
    out[8] = (m[4] * b10 - m[5] * b08 + m[7] * b06) * determinant;
    out[9] = (m[1] * b08 - m[0] * b10 - m[3] * b06) * determinant;
    out[10] = (m[12] * b04 - m[13] * b02 + m[15] * b00) * determinant;
    out[11] = (m[9] * b02 - m[8] * b04 - m[11] * b00) * determinant;
    out[12] = (m[5] * b07 - m[4] * b09 - m[6] * b06) * determinant;
    out[13] = (m[0] * b09 - m[1] * b07 + m[2] * b06) * determinant;
    out[14] = (m[13] * b01 - m[12] * b03 - m[14] * b00) * determinant;
    out[15] = (m[8] * b03 - m[9] * b01 + m[10] * b00) * determinant;
    return true;
  }

  function transform(matrix, point) {
    const [x, y, z, w = 1] = point;
    return [
      matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12] * w,
      matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13] * w,
      matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14] * w,
      matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15] * w
    ];
  }

  function rayBox(origin, direction, minimum, maximum) {
    let near = 0, far = Infinity;
    for (let axis = 0; axis < 3; axis += 1) {
      if (Math.abs(direction[axis]) < 1e-6) {
        if (origin[axis] < minimum[axis] || origin[axis] > maximum[axis]) return null;
        continue;
      }
      let first = (minimum[axis] - origin[axis]) / direction[axis];
      let second = (maximum[axis] - origin[axis]) / direction[axis];
      if (first > second) [first, second] = [second, first];
      near = Math.max(near, first); far = Math.min(far, second);
      if (near > far) return null;
    }
    return far >= 0 ? near : null;
  }

  class SolidBoardScene {
    constructor(canvas) {
      this.canvas = canvas;
      this.host = canvas.parentElement;
      this.gl = this.canvas.getContext('webgl', { alpha: true, antialias: true, powerPreference: 'high-performance' });
      this.available = Boolean(this.gl);
      this.game = null;
      this.orientation = 'w';
      this.selected = null;
      this.legalMoves = [];
      this.dragPiece = null;
      this.camera = { pitch: 54, yaw: 0, panX: 0, panY: 0, zoom: 1 };
      this.frame = null;
      if (!this.available) {
        this.canvas.classList.add('webgl-unavailable');
        return;
      }
      try {
        this.setup();
        this.host.classList.add('solid-board-active');
        this.observer = new ResizeObserver(() => this.queueDraw());
        this.observer.observe(this.host);
      } catch (error) {
        console.warn('Solid board renderer is unavailable.', error);
        this.available = false;
        this.canvas.classList.add('webgl-unavailable');
      }
    }

    setup() {
      const gl = this.gl;
      this.program = createProgram(gl);
      this.locations = {
        position: gl.getAttribLocation(this.program, 'aPosition'), normal: gl.getAttribLocation(this.program, 'aNormal'),
        projection: gl.getUniformLocation(this.program, 'uProjection'), view: gl.getUniformLocation(this.program, 'uView'),
        model: gl.getUniformLocation(this.program, 'uModel'), color: gl.getUniformLocation(this.program, 'uColor'), shine: gl.getUniformLocation(this.program, 'uShine')
      };
      gl.enableVertexAttribArray(this.locations.position);
      gl.enableVertexAttribArray(this.locations.normal);
      const upload = data => {
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
        return { buffer, count: data.length / 6 };
      };
      this.mesh = {
        tile: upload(box(1.01, .07, 1.01)), base: upload(box(8.85, .36, 8.85)), marker: upload(disc(.15)), captureMarker: upload(disc(.31, .43)),
        glyph: upload(box(1, .026, .055)),
        common: upload(lathe([[.38,0],[.45,.05],[.43,.13],[.31,.21],[.22,.28],[.18,.37]])),
        pawn: upload(lathe([[.19,.28],[.22,.42],[.27,.55],[.21,.67],[.17,.77]])),
        rook: upload(lathe([[.25,.28],[.30,.42],[.27,.79],[.35,.87],[.35,.97]])),
        bishop: upload(lathe([[.21,.28],[.24,.47],[.18,.7],[.24,.82],[.17,.96]])),
        queen: upload(lathe([[.23,.28],[.3,.48],[.22,.75],[.32,.86],[.25,.99]])),
        king: upload(lathe([[.24,.28],[.31,.48],[.22,.76],[.29,.89],[.2,1.03]])),
        sphere: upload(sphere(.24)), turret: upload(box(.16, .18, .16)),
        crossV: upload(box(.09, .34, .09)), crossH: upload(box(.31, .09, .09)),
        knight: upload(extrusion([[-.27,.08],[-.34,.29],[-.18,.47],[-.1,.82],[.13,.95],[.3,.78],[.23,.62],[.39,.4],[.19,.13]], .34))
      };
      this.projection = new Float32Array(16);
      this.view = new Float32Array(16);
      this.viewProjection = new Float32Array(16);
      this.inverseViewProjection = new Float32Array(16);
      this.modelMatrix = new Float32Array(16);
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    setPosition(game, orientation, selected = null, legalMoves = []) {
      this.game = game;
      this.orientation = orientation;
      this.selected = selected;
      this.legalMoves = legalMoves;
      this.queueDraw();
    }
    setDragPiece(piece, square) {
      if (!piece || !square) return;
      const visualRow = this.orientation === 'w' ? square.r : 7 - square.r;
      const visualColumn = this.orientation === 'w' ? square.c : 7 - square.c;
      this.dragPiece = { piece: { ...piece }, from: { ...square }, x: visualColumn - 3.5, z: visualRow - 3.5 };
      this.queueDraw();
    }
    updateDragFromPointer(clientX, clientY) {
      if (!this.dragPiece) return;
      const ray = this.rayFromClient(clientX, clientY);
      if (!ray || Math.abs(ray.direction[1]) < 1e-6) return;
      const distance = (.2 - ray.origin[1]) / ray.direction[1];
      if (distance < 0) return;
      this.dragPiece.x = Math.max(-3.9, Math.min(3.9, ray.origin[0] + ray.direction[0] * distance));
      this.dragPiece.z = Math.max(-3.9, Math.min(3.9, ray.origin[2] + ray.direction[2] * distance));
      this.queueDraw();
    }
    clearDragPiece() {
      if (!this.dragPiece) return;
      this.dragPiece = null;
      this.queueDraw();
    }
    setCamera(camera) {
      this.camera = {
        pitch: camera.pitch,
        yaw: camera.yaw,
        panX: camera.panX || 0,
        panY: camera.panY || 0,
        zoom: camera.zoom || 1
      };
      this.queueDraw();
    }
    queueDraw() {
      if (!this.available || this.frame) return;
      this.frame = requestAnimationFrame(() => { this.frame = null; this.draw(); });
    }

    resize() {
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(this.host.clientWidth * scale));
      const height = Math.max(1, Math.round(this.host.clientHeight * scale));
      if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
      return { width, height };
    }

    drawMesh(mesh, x, y, z, color, shine = .2, rotation = 0, scale = 1) {
      const gl = this.gl, locations = this.locations;
      model(this.modelMatrix, x, y, z, rotation, scale);
      gl.uniformMatrix4fv(locations.model, false, this.modelMatrix);
      gl.uniform3fv(locations.color, color);
      gl.uniform1f(locations.shine, shine);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
      gl.vertexAttribPointer(locations.position, 3, gl.FLOAT, false, 24, 0);
      gl.vertexAttribPointer(locations.normal, 3, gl.FLOAT, false, 24, 12);
      gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
    }

    drawBoard() {
      this.drawMesh(this.mesh.base, 0, -.2, 0, WOOD, .15);
      const checkedKing = this.game?.isInCheck() ? this.game.kingSquare(this.game.turn) : null;
      for (let row = 0; row < 8; row += 1) for (let column = 0; column < 8; column += 1) {
        const gameRow = this.orientation === 'w' ? row : 7 - row;
        const gameColumn = this.orientation === 'w' ? column : 7 - column;
        const matches = square => square?.r === gameRow && square?.c === gameColumn;
        let color = (row + column) % 2 ? DARK_TILE : LIGHT_TILE;
        if (matches(this.game?.lastMove?.from) || matches(this.game?.lastMove?.to)) color = blend(color, SELECTED_TILE, .52);
        if (matches(this.selected)) color = SELECTED_TILE;
        if (matches(checkedKing)) color = CHECK_TILE;
        this.drawMesh(this.mesh.tile, column - 3.5, .02, row - 3.5, color, .08);
      }
      this.legalMoves.forEach(move => {
        const row = this.orientation === 'w' ? move.to.r : 7 - move.to.r;
        const column = this.orientation === 'w' ? move.to.c : 7 - move.to.c;
        const capture = move.capture || move.enPassant;
        this.drawMesh(capture ? this.mesh.captureMarker : this.mesh.marker, column - 3.5, .075, row - 3.5, capture ? CAPTURE_MARKER : LEGAL_MARKER, .05);
      });
    }

    drawGlyph(character, anchorX, anchorZ, scale = .27) {
      (GLYPHS[character] || []).forEach(segmentName => {
        const [start, end] = GLYPH_SEGMENTS[segmentName];
        const dx = (end[0] - start[0]) * scale;
        const dz = (end[1] - start[1]) * scale;
        const centerX = anchorX + (start[0] + end[0]) * scale * .5;
        const centerZ = anchorZ + (start[1] + end[1]) * scale * .5;
        const length = Math.hypot(dx, dz);
        this.drawMesh(this.mesh.glyph, centerX, .025, centerZ, COORDINATE, .22, Math.atan2(-dz, dx), [length, 1, 1]);
      });
    }

    drawCoordinates() {
      for (let index = 0; index < 8; index += 1) {
        const rank = this.orientation === 'w' ? String(8 - index) : String(index + 1);
        const file = this.orientation === 'w' ? FILES[index] : FILES[7 - index];
        this.drawGlyph(rank, -4.2, index - 3.5);
        this.drawGlyph(file, index - 3.5, 4.2);
      }
    }

    drawPiece(piece, x, z, scaleMultiplier = 1, lift = 0) {
      const color = piece.color === 'w' ? WHITE : BLACK;
      const reverse = piece.color === 'w' ? Math.PI : 0;
      const size = PIECE_SCALE * scaleMultiplier * (piece.type === 'p' ? PAWN_SCALE : 1);
      const draw = (mesh, y, shine = .48, rotation = 0, scale = 1) => this.drawMesh(mesh, x, y * size + lift, z, color, shine, rotation, scale * size);
      draw(this.mesh.common, .08);
      if (piece.type === 'p') { draw(this.mesh.pawn, 0); draw(this.mesh.sphere, .93, .58, 0, 1); return; }
      if (piece.type === 'r') {
        draw(this.mesh.rook, 0);
        [[-.24,-.24],[.24,-.24],[-.24,.24],[.24,.24]].forEach(([dx, dz]) => this.drawMesh(this.mesh.turret, x + dx * size, 1.03 * size + lift, z + dz * size, color, .45, 0, size));
        return;
      }
      if (piece.type === 'n') { draw(this.mesh.knight, .27, .45, reverse); return; }
      if (piece.type === 'b') { draw(this.mesh.bishop, 0); draw(this.mesh.sphere, 1.02, .5, 0, .82); return; }
      if (piece.type === 'q') {
        draw(this.mesh.queen, 0);
        [[0,0],[-.22,0],[.22,0],[0,-.22],[0,.22]].forEach(([dx, dz], index) => this.drawMesh(this.mesh.sphere, x + dx * size, (1.11 + (index ? -.04 : .04)) * size + lift, z + dz * size, color, .57, 0, .36 * size));
        return;
      }
      draw(this.mesh.king, 0);
      this.drawMesh(this.mesh.crossV, x, 1.14 * size + lift, z, color, .55, 0, size);
      this.drawMesh(this.mesh.crossH, x, 1.22 * size + lift, z, color, .55, 0, size);
    }

    drawPieces() {
      if (!this.game) return;
      for (let row = 0; row < 8; row += 1) for (let column = 0; column < 8; column += 1) {
        const piece = this.game.getPiece(row, column);
        if (!piece) continue;
        const visualRow = this.orientation === 'w' ? row : 7 - row;
        const visualColumn = this.orientation === 'w' ? column : 7 - column;
        if (this.dragPiece?.from?.r === row && this.dragPiece?.from?.c === column) continue;
        this.drawPiece(piece, visualColumn - 3.5, visualRow - 3.5);
      }
      if (this.dragPiece) {
        this.drawMesh(this.mesh.marker, this.dragPiece.x, .085, this.dragPiece.z, LEGAL_MARKER, .05, 0, 1.45);
        this.drawPiece(this.dragPiece.piece, this.dragPiece.x, this.dragPiece.z, .92, .18);
      }
    }

    rayFromClient(clientX, clientY) {
      const bounds = this.canvas.getBoundingClientRect();
      if (clientX < bounds.left || clientX > bounds.right || clientY < bounds.top || clientY > bounds.bottom) return null;
      const x = (clientX - bounds.left) / bounds.width * 2 - 1;
      const y = 1 - (clientY - bounds.top) / bounds.height * 2;
      const nearClip = transform(this.inverseViewProjection, [x, y, -1, 1]);
      const farClip = transform(this.inverseViewProjection, [x, y, 1, 1]);
      const near = nearClip.slice(0, 3).map(value => value / nearClip[3]);
      const far = farClip.slice(0, 3).map(value => value / farClip[3]);
      return { origin: near, direction: normalize(far.map((value, index) => value - near[index])) };
    }

    squareFromBoardPlane(ray) {
      if (Math.abs(ray.direction[1]) < 1e-6) return null;
      const distance = (.06 - ray.origin[1]) / ray.direction[1];
      if (distance < 0) return null;
      const x = ray.origin[0] + ray.direction[0] * distance;
      const z = ray.origin[2] + ray.direction[2] * distance;
      if (x < -4 || x >= 4 || z < -4 || z >= 4) return null;
      const visualColumn = Math.floor(x + 4);
      const visualRow = Math.floor(z + 4);
      return {
        distance,
        r: this.orientation === 'w' ? visualRow : 7 - visualRow,
        c: this.orientation === 'w' ? visualColumn : 7 - visualColumn
      };
    }

    legalTargetFromRay(ray) {
      if (!this.selected || !this.legalMoves.length) return null;
      let closest = null;
      this.legalMoves.forEach(move => {
        const visualRow = this.orientation === 'w' ? move.to.r : 7 - move.to.r;
        const visualColumn = this.orientation === 'w' ? move.to.c : 7 - move.to.c;
        const x = visualColumn - 3.5;
        const z = visualRow - 3.5;
        // A shallow volume follows the full tile surface. It makes the marker
        // and every visible part of its square equally clickable at low angles.
        const distance = rayBox(ray.origin, ray.direction, [x - .49, -.015, z - .49], [x + .49, .16, z + .49]);
        if (distance !== null && (!closest || distance < closest.distance)) {
          closest = { distance, r: move.to.r, c: move.to.c };
        }
      });
      return closest;
    }

    pickSquare(clientX, clientY) {
      if (!this.game) return null;
      const ray = this.rayFromClient(clientX, clientY);
      if (!ray) return null;
      const planeSquare = this.squareFromBoardPlane(ray);
      const legalTarget = this.legalTargetFromRay(ray);
      if (legalTarget) return { r: legalTarget.r, c: legalTarget.c };
      let pieceHit = null;
      for (let row = 0; row < 8; row += 1) for (let column = 0; column < 8; column += 1) {
        if (!this.game.getPiece(row, column)) continue;
        const visualRow = this.orientation === 'w' ? row : 7 - row;
        const visualColumn = this.orientation === 'w' ? column : 7 - column;
        const x = visualColumn - 3.5, z = visualRow - 3.5;
        const distance = rayBox(ray.origin, ray.direction, [x - .42, .02, z - .42], [x + .42, 1.2, z + .42]);
        if (distance !== null && (!pieceHit || distance < pieceHit.distance)) pieceHit = { distance, r: row, c: column };
      }
      if (pieceHit) return { r: pieceHit.r, c: pieceHit.c };
      return planeSquare ? { r: planeSquare.r, c: planeSquare.c } : null;
    }

    draw() {
      if (!this.available) return;
      const { width, height } = this.resize();
      const gl = this.gl, elevation = this.camera.pitch * Math.PI / 180, yaw = this.camera.yaw * Math.PI / 180;
      const zoom = Math.max(.78, Math.min(1.22, this.camera.zoom || 1));
      const distance = 13.3 / zoom, horizontal = Math.cos(elevation) * distance;
      const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
      const target = [
        -(this.camera.panX || 0) * .012 * right[0],
        .25 + (this.camera.panY || 0) * .01,
        -(this.camera.panX || 0) * .012 * right[2]
      ];
      const eye = [
        target[0] + Math.sin(yaw) * horizontal,
        target[1] + Math.sin(elevation) * distance + .45,
        target[2] + Math.cos(yaw) * horizontal
      ];
      perspective(this.projection, 43 * Math.PI / 180, width / height, .1, 40);
      lookAt(this.view, eye, target);
      multiply(this.viewProjection, this.projection, this.view);
      invert(this.inverseViewProjection, this.viewProjection);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(this.program);
      gl.uniformMatrix4fv(this.locations.projection, false, this.projection);
      gl.uniformMatrix4fv(this.locations.view, false, this.view);
      this.drawBoard();
      this.drawCoordinates();
      this.drawPieces();
    }
  }

  window.TournamentSolidBoard = { SolidBoardScene };
})();
