/*
 * The landing hero's knowledge constellation, in WebGL.
 *
 * Loose material (notes, flashcards, questions, assignments) starts scattered,
 * then settles onto a binder spine: courses as rings, units beside them, each
 * unit's material in a tidy row, and fine threads drawing in to bind it all.
 * Concepts on the right link material across courses.
 *
 * Cost is deliberately small: unlit materials, one instanced mesh per shape,
 * two line batches, no post-processing, a capped pixel ratio, fewer objects
 * on weak devices, and no rendering at all while the hero is off screen or
 * the tab is hidden. This module is only ever loaded with a dynamic import.
 */
import {
  BufferAttribute, BufferGeometry, CircleGeometry, Color, InstancedMesh, LineBasicMaterial, LineSegments,
  MathUtils, MeshBasicMaterial, Object3D, PerspectiveCamera, PlaneGeometry, Scene,
  TorusGeometry, Vector3, WebGLRenderer, type Material,
} from 'three'
import { buildLayout, seeded, type LayoutNode, type NodeKind } from './constellationLayout'

export type ConstellationPalette = {
  ink: string
  paper: string
  rule: string
  ruleStrong: string
  brand: string
  courses: string[]
}

export type ConstellationOptions = {
  quality: 'high' | 'low'
  palette: ConstellationPalette
  /* Screen positions (CSS px within the canvas) and visibility of each course, for HTML labels. */
  onLabels?: (labels: { x: number; y: number; opacity: number }[]) => void
}

export type ConstellationHandle = {
  setPointer: (x: number, y: number) => void
  setScroll: (progress: number) => void
  setPalette: (palette: ConstellationPalette) => void
  dispose: () => void
}

type Shape = 'ring' | 'dot' | 'paper' | 'paperEdge' | 'cardStripe' | 'question' | 'questionCore' | 'task' | 'concept'

type Item = {
  node: LayoutNode
  start: Vector3
  target: Vector3
  spin: Vector3
  delay: number
  phase: number
}

const ORGANIZE_START = 0.35
const ITEM_DURATION = 1.5

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const smooth = (edge0: number, edge1: number, value: number) => {
  const t = MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/* Which instanced shapes draw each kind of node, and at what size. */
const PARTS: Record<NodeKind, { shape: Shape; scale: [number, number]; z?: number }[]> = {
  course: [{ shape: 'ring', scale: [1, 1] }],
  unit: [{ shape: 'dot', scale: [1, 1] }],
  note: [{ shape: 'paperEdge', scale: [0.46, 0.58] }, { shape: 'paper', scale: [0.43, 0.55], z: 0.002 }],
  card: [{ shape: 'paperEdge', scale: [0.64, 0.4] }, { shape: 'paper', scale: [0.61, 0.37], z: 0.002 }, { shape: 'cardStripe', scale: [0.61, 0.07], z: 0.004 }],
  question: [{ shape: 'question', scale: [1, 1] }, { shape: 'questionCore', scale: [1, 1], z: 0.002 }],
  assignment: [{ shape: 'task', scale: [0.3, 0.3] }],
  concept: [{ shape: 'concept', scale: [1, 1] }],
}

export function mountConstellation(canvas: HTMLCanvasElement, options: ConstellationOptions): ConstellationHandle {
  const compact = options.quality === 'low'
  const renderer = new WebGLRenderer({ canvas, antialias: !compact, alpha: true, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, compact ? 1.25 : 1.75))
  renderer.setClearColor(0x000000, 0)

  const scene = new Scene()
  const camera = new PerspectiveCamera(30, 1, 0.1, 100)
  camera.position.set(0, 0, 22)

  const layout = buildLayout(compact)
  const random = seeded(20261002)

  // Each node's scattered starting point, spin, and place in the binding sequence.
  const courseOrder = new Map<string, number>()
  const items: Item[] = layout.nodes.map((node, index) => {
    const start = new Vector3((random() - 0.5) * 15, (random() - 0.5) * 10, (random() - 0.5) * 6)
    const target = new Vector3(node.x, node.y, node.z)
    const course = node.course < 0 ? 3 : node.course
    const rank = node.kind === 'course' ? 0 : node.kind === 'unit' ? 1 : node.kind === 'concept' ? 3 : 2
    const order = courseOrder.get(`${course}-${rank}`) ?? 0
    courseOrder.set(`${course}-${rank}`, order + 1)
    const delay = ORGANIZE_START + rank * 0.55 + course * 0.22 + order * 0.045 + random() * 0.12
    return { node, start, target, spin: new Vector3((random() - 0.5) * 2.4, (random() - 0.5) * 2.4, (random() - 0.5) * 3.2), delay, phase: index * 0.7 }
  })
  const organizedAt = Math.max(...items.map((item) => item.delay)) + ITEM_DURATION

  // Geometry and materials, one per shape.
  const geometries: Record<Shape, BufferGeometry> = {
    ring: new TorusGeometry(0.34, 0.045, 10, compact ? 36 : 64),
    dot: new CircleGeometry(0.1, 24),
    paper: new PlaneGeometry(1, 1),
    paperEdge: new PlaneGeometry(1, 1),
    cardStripe: new PlaneGeometry(1, 1),
    question: new CircleGeometry(0.15, 28),
    questionCore: new CircleGeometry(0.1, 28),
    task: new PlaneGeometry(1, 1),
    concept: new CircleGeometry(0.075, 20),
  }
  const materials: Record<Shape, MeshBasicMaterial> = {
    ring: new MeshBasicMaterial(),
    dot: new MeshBasicMaterial(),
    paper: new MeshBasicMaterial(),
    paperEdge: new MeshBasicMaterial(),
    cardStripe: new MeshBasicMaterial(),
    question: new MeshBasicMaterial(),
    questionCore: new MeshBasicMaterial(),
    task: new MeshBasicMaterial(),
    concept: new MeshBasicMaterial(),
  }

  // Shapes that take each node's course color get per-instance colors.
  const perCourse: Shape[] = ['ring', 'dot', 'cardStripe', 'question']
  const meshes = new Map<Shape, { mesh: InstancedMesh; parts: { item: Item; scale: [number, number]; z: number }[] }>()
  for (const item of items) {
    for (const part of PARTS[item.node.kind]) {
      const entry = meshes.get(part.shape) ?? { mesh: null as unknown as InstancedMesh, parts: [] }
      entry.parts.push({ item, scale: part.scale, z: part.z ?? 0 })
      meshes.set(part.shape, entry)
    }
  }
  for (const [shape, entry] of meshes) {
    entry.mesh = new InstancedMesh(geometries[shape], materials[shape], entry.parts.length)
    entry.mesh.frustumCulled = false
    scene.add(entry.mesh)
  }

  // Threads (structure) and links (concepts), redrawn every frame from node positions.
  const threadPositions = new Float32Array(layout.threads.length * 6)
  const linkPositions = new Float32Array(layout.links.length * 6)
  const threadGeometry = new BufferGeometry()
  threadGeometry.setAttribute('position', new BufferAttribute(threadPositions, 3))
  const linkGeometry = new BufferGeometry()
  linkGeometry.setAttribute('position', new BufferAttribute(linkPositions, 3))
  const threadMaterial = new LineBasicMaterial({ transparent: true, opacity: 0.75 })
  const linkMaterial = new LineBasicMaterial({ transparent: true, opacity: 0.6 })
  const threads = new LineSegments(threadGeometry, threadMaterial)
  const links = new LineSegments(linkGeometry, linkMaterial)
  threads.frustumCulled = false
  links.frustumCulled = false
  scene.add(threads, links)

  // The binder spine the courses hang on.
  const spinePositions = new Float32Array([layout.nodes[0].x, layout.spine[0], -0.05, layout.nodes[0].x, layout.spine[1], -0.05])
  const spineGeometry = new BufferGeometry()
  spineGeometry.setAttribute('position', new BufferAttribute(spinePositions, 3))
  const spineMaterial = new LineBasicMaterial({ transparent: true, opacity: 0 })
  const spine = new LineSegments(spineGeometry, spineMaterial)
  scene.add(spine)

  function applyPalette(palette: ConstellationPalette) {
    const color = (value: string) => new Color(value)
    materials.paper.color = color(palette.paper)
    materials.paperEdge.color = color(palette.ruleStrong)
    materials.task.color = color(palette.ink)
    materials.questionCore.color = color(palette.paper)
    materials.concept.color = color(palette.brand)
    threadMaterial.color = color(palette.ruleStrong)
    linkMaterial.color = color(palette.brand)
    spineMaterial.color = color(palette.ink)
    for (const shape of perCourse) {
      const entry = meshes.get(shape)
      if (!entry) continue
      entry.parts.forEach((part, index) => entry.mesh.setColorAt(index, color(palette.courses[part.item.node.course % palette.courses.length] ?? palette.brand)))
      if (entry.mesh.instanceColor) entry.mesh.instanceColor.needsUpdate = true
    }
  }
  applyPalette(options.palette)

  // Live positions, so threads can follow the nodes.
  const positions = new Map<string, Vector3>(items.map((item) => [item.node.id, item.start.clone()]))
  const progressOf = new Map<string, number>()
  const helper = new Object3D()

  const pointer = { x: 0, y: 0, tx: 0, ty: 0 }
  let scroll = 0
  let width = 1
  let height = 1
  let frame = 0
  let running = false
  let visible = true
  let disposed = false
  // Development only: ?scene=settled starts at the finished composition for visual review.
  let elapsed = import.meta.env.DEV && new URLSearchParams(window.location.search).get('scene') === 'settled' ? 30 : 0
  let last = performance.now()
  let lastLabels = ''
  let settledFrames = 0

  function resize() {
    const rect = canvas.getBoundingClientRect()
    width = Math.max(1, rect.width)
    height = Math.max(1, rect.height)
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    // Frame the map with its course labels (about 11.4 units wide, 9.2 tall); widen on narrow frames.
    // The compact map is narrower and its labels sit above the rings, so it frames tighter.
    const needed = compact ? Math.max(7.6, 9.4 / camera.aspect) : Math.max(9.2, 11.6 / camera.aspect)
    camera.position.z = needed / (2 * Math.tan(MathUtils.degToRad(camera.fov / 2)))
    camera.position.x = compact ? -0.55 : -0.85
    camera.updateProjectionMatrix()
  }

  function update(time: number) {
    for (const item of items) {
      const p = easeInOut(MathUtils.clamp((time - item.delay) / ITEM_DURATION, 0, 1))
      progressOf.set(item.node.id, p)
      const position = positions.get(item.node.id)!
      position.lerpVectors(item.start, item.target, p)
      // A slow drift once settled keeps the map alive without asking for attention.
      const drift = compact ? 0 : 0.045 * p
      position.y += Math.sin(time * 0.35 + item.phase) * drift
      position.x += Math.cos(time * 0.27 + item.phase) * drift * 0.6
    }

    for (const entry of meshes.values()) {
      entry.parts.forEach((part, index) => {
        const p = progressOf.get(part.item.node.id) ?? 0
        const position = positions.get(part.item.node.id)!
        const appear = 0.55 + 0.45 * smooth(0, 0.35, p)
        helper.position.set(position.x, position.y, position.z + part.z)
        helper.rotation.set(part.item.spin.x * (1 - p), part.item.spin.y * (1 - p), part.item.spin.z * (1 - p))
        helper.scale.set(part.scale[0] * appear, part.scale[1] * appear, 1)
        if (part.item.node.kind === 'card' && part.scale[1] < 0.1) helper.position.y += 0.15 * appear
        helper.updateMatrix()
        entry.mesh.setMatrixAt(index, helper.matrix)
      })
      entry.mesh.instanceMatrix.needsUpdate = true
    }

    // Threads draw from child toward parent as the child settles.
    layout.threads.forEach(([from, to], index) => {
      const a = positions.get(from)!
      const b = positions.get(to)!
      const reach = smooth(0.62, 1, progressOf.get(from) ?? 0) * smooth(0.5, 1, progressOf.get(to) ?? 0)
      threadPositions.set([a.x, a.y, a.z - 0.01, a.x + (b.x - a.x) * reach, a.y + (b.y - a.y) * reach, a.z + (b.z - a.z) * reach - 0.01], index * 6)
    })
    threadGeometry.attributes.position.needsUpdate = true

    const linkReach = smooth(organizedAt - 0.9, organizedAt + 0.6, time)
    layout.links.forEach(([from, to], index) => {
      const a = positions.get(from)!
      const b = positions.get(to)!
      linkPositions.set([a.x, a.y, a.z - 0.02, a.x + (b.x - a.x) * linkReach, a.y + (b.y - a.y) * linkReach, a.z + (b.z - a.z) * linkReach - 0.02], index * 6)
    })
    linkGeometry.attributes.position.needsUpdate = true
    linkMaterial.opacity = 0.42 * linkReach
    spineMaterial.opacity = 0.5 * smooth(ORGANIZE_START + 0.2, ORGANIZE_START + 1.4, time)

    // Pointer parallax and scroll: a slight turn toward the cursor, a gentle tilt away on scroll.
    pointer.x += (pointer.tx - pointer.x) * 0.045
    pointer.y += (pointer.ty - pointer.y) * 0.045
    scene.rotation.y = pointer.x * 0.16
    scene.rotation.x = -pointer.y * 0.09 + scroll * 0.22
    scene.position.y = scroll * 1.1

    if (options.onLabels) {
      scene.updateMatrixWorld()
      camera.updateMatrixWorld()
      const labels = items.filter((item) => item.node.kind === 'course').map((item) => {
        const projected = positions.get(item.node.id)!.clone().applyMatrix4(scene.matrixWorld).project(camera)
        return { x: Math.round((projected.x + 1) / 2 * width), y: Math.round((1 - projected.y) / 2 * height), opacity: Number(smooth(0.8, 1, progressOf.get(item.node.id) ?? 0).toFixed(2)) }
      })
      const key = JSON.stringify(labels)
      if (key !== lastLabels) { lastLabels = key; options.onLabels(labels) }
    }
  }

  function render(now: number) {
    if (!running || disposed) return
    const delta = Math.min(0.05, (now - last) / 1000)
    last = now
    elapsed += delta
    scene.updateMatrixWorld()
    update(elapsed)
    renderer.render(scene, camera)
    // Weak devices stop drawing once the map has settled and nothing is moving.
    const still = Math.abs(pointer.tx - pointer.x) < 0.001 && Math.abs(pointer.ty - pointer.y) < 0.001
    settledFrames = compact && elapsed > organizedAt + 0.8 && still ? settledFrames + 1 : 0
    if (settledFrames > 30) { running = false; return }
    frame = requestAnimationFrame(render)
  }

  function start() {
    if (running || disposed || !visible || document.hidden) return
    running = true
    last = performance.now()
    frame = requestAnimationFrame(render)
  }

  function stop() {
    running = false
    cancelAnimationFrame(frame)
  }

  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    if (visible) start()
    else stop()
  })
  observer.observe(canvas)
  const resizeObserver = new ResizeObserver(() => { resize(); if (!running) { scene.updateMatrixWorld(); update(elapsed); renderer.render(scene, camera) } })
  resizeObserver.observe(canvas)
  const onVisibility = () => { if (document.hidden) stop(); else start() }
  document.addEventListener('visibilitychange', onVisibility)

  resize()
  start()

  return {
    setPointer(x, y) {
      pointer.tx = MathUtils.clamp(x, -1, 1)
      pointer.ty = MathUtils.clamp(y, -1, 1)
      start()
    },
    setScroll(progress) {
      scroll = MathUtils.clamp(progress, 0, 1)
      start()
    },
    setPalette(palette) {
      applyPalette(palette)
      if (!running) { update(elapsed); renderer.render(scene, camera) }
    },
    dispose() {
      disposed = true
      stop()
      observer.disconnect()
      resizeObserver.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      for (const entry of meshes.values()) entry.mesh.dispose()
      for (const geometry of [...Object.values(geometries), threadGeometry, linkGeometry, spineGeometry]) geometry.dispose()
      for (const material of [...Object.values(materials), threadMaterial, linkMaterial, spineMaterial] as Material[]) material.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
    },
  }
}
