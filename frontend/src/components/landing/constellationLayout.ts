/*
 * The organized "knowledge constellation": what a student's material looks like
 * once bindit has bound it together. Shared by the WebGL scene and its static
 * SVG fallback so both draw the same picture.
 *
 * Composition, left to right: a binder spine holding three courses (rings),
 * each course's units, the material inside each unit (notes, flashcards,
 * questions, assignments), and on the right the concepts that the material
 * connects across courses.
 */

export type NodeKind = 'course' | 'unit' | 'note' | 'card' | 'question' | 'assignment' | 'concept'

export type LayoutNode = {
  id: string
  kind: NodeKind
  x: number
  y: number
  z: number
  parent?: string
  course: number
  label?: string
}

export type Layout = { nodes: LayoutNode[]; threads: [string, string][]; links: [string, string][]; spine: [number, number] }

/* The demo student's courses, so the hero matches the live product preview below it. */
export const CONSTELLATION_COURSES = ['AP Biology', 'Chemistry', 'US History'] as const

const MATERIAL_ORDER: NodeKind[] = ['note', 'card', 'question', 'assignment']

export function buildLayout(compact: boolean): Layout {
  const nodes: LayoutNode[] = []
  const threads: [string, string][] = []
  const courseY = [2.7, 0, -2.7]
  const unitCounts = compact ? [2, 2, 2] : [3, 2, 3]
  const materialCount = compact ? 2 : 4
  const spineX = -4.4

  CONSTELLATION_COURSES.forEach((label, courseIndex) => {
    const courseId = `c${courseIndex}`
    nodes.push({ id: courseId, kind: 'course', x: spineX, y: courseY[courseIndex], z: 0, course: courseIndex, label })
    const units = unitCounts[courseIndex]
    for (let unit = 0; unit < units; unit += 1) {
      const unitId = `${courseId}u${unit}`
      const y = courseY[courseIndex] + (unit - (units - 1) / 2) * 0.78
      nodes.push({ id: unitId, kind: 'unit', x: -2.7, y, z: 0.1, parent: courseId, course: courseIndex })
      threads.push([unitId, courseId])
      for (let item = 0; item < materialCount; item += 1) {
        const kind = MATERIAL_ORDER[(item + unit + courseIndex) % MATERIAL_ORDER.length]
        const id = `${unitId}m${item}`
        nodes.push({ id, kind, x: -1.55 + item * 0.92, y, z: 0.15 + ((item + unit) % 3) * 0.05, parent: unitId, course: courseIndex })
        threads.push([id, item === 0 ? unitId : `${unitId}m${item - 1}`])
      }
    }
  })

  // Concepts on the right, each tied to material from more than one course.
  const conceptSpots = compact
    ? [[2.6, 1.6], [3.3, -0.4], [2.5, -2.2]]
    : [[2.9, 2.6], [3.9, 1.3], [3.1, 0.1], [4.2, -1.2], [3.0, -2.4], [4.4, 3.4]]
  const materials = nodes.filter((node) => MATERIAL_ORDER.includes(node.kind))
  const links: [string, string][] = []
  conceptSpots.forEach(([x, y], index) => {
    const id = `k${index}`
    nodes.push({ id, kind: 'concept', x, y, z: 0.3, course: -1 })
    // Nearest material from two different courses: knowledge connecting across subjects.
    const byCourse = [0, 1, 2].map((course) => materials
      .filter((node) => node.course === course)
      .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0])
    const near = byCourse.filter(Boolean).sort((a, b) => Math.hypot(a!.x - x, a!.y - y) - Math.hypot(b!.x - x, b!.y - y)).slice(0, 2)
    for (const node of near) links.push([id, node!.id])
  })

  return { nodes, threads, links, spine: [courseY[0] + 1.25, courseY[2] - 1.25] }
}

/* Deterministic pseudo-random numbers so the scattered state is the same on every visit. */
export function seeded(seed: number) {
  let value = seed >>> 0
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0
    return value / 4294967296
  }
}
