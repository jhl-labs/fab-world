import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

type ProcessBand = 'photo' | 'etch' | 'deposition' | 'implant' | 'cmp'
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'data/layouts/fab-default.json')
const columnWidths = [11, 12, 11, 12, 11, 13, 13, 11, 12, 11, 12, 10]
const rowDepths = [27, 29, 30, 32, 32, 30]
const aisle = 3
const totalWidth = columnWidths.reduce((sum, width) => sum + width, 0) + aisle * (columnWidths.length - 1)
const totalDepth = rowDepths.reduce((sum, depth) => sum + depth, 0) + aisle * (rowDepths.length - 1)
const bands: ProcessBand[] = ['photo', 'etch', 'deposition', 'implant', 'cmp']
const types = ['lithography', 'etcher', 'cvd', 'pvd', 'cmp', 'implanter', 'cleaner', 'furnace', 'metrology']

let zCursor = -totalDepth / 2
const bays: unknown[] = []
const zones: unknown[] = []
const railSegments: unknown[] = []
const columnCenters: number[] = []
const rowCenters: number[] = []

for (let row = 0; row < rowDepths.length; row++) {
  const depth = rowDepths[row]!
  const z = zCursor + depth / 2
  rowCenters.push(z)
  let xCursor = -totalWidth / 2
  for (let col = 0; col < columnWidths.length; col++) {
    const width = columnWidths[col]!
    const x = xCursor + width / 2
    if (row === 0) columnCenters.push(x)
    const band = bands[(row * 2 + col) % bands.length]!
    const equipment = Array.from({ length: 4 + ((row + col) % 2) }, (_, index) => {
      const id = `${types[(row * columnWidths.length + col + index) % types.length]}-${String(row * 100 + col * 10 + index + 1).padStart(3, '0')}`
      const localX = x + ((index % 2) - 0.5) * Math.min(width * 0.42, 4.4)
      const localZ = z + (Math.floor(index / 2) - 0.5) * Math.min(depth * 0.36, 7)
      return {
        id,
        type: types[(row * columnWidths.length + col + index) % types.length],
        position: [Number(localX.toFixed(2)), 0, Number(localZ.toFixed(2))],
        rotation: index % 2 === 0 ? 0 : Math.PI,
        hazardCapable: index === 0 && (row + col) % 3 === 0,
        loadports: [{ id: `${id}-lp0`, offset: [0, 0, 2.4] }]
      }
    })
    bays.push({
      id: `bay-${row}-${col}`, row, col, processBand: band,
      variant: (row + col) % 11 === 0 ? 'superbay' : (row + col) % 7 === 0 ? 'metrology' : 'standard', equipment
    })
    zones.push({
      id: `zone-bay-${row}-${col}`, kind: 'bay-interior',
      polygon: [[xCursor, zCursor], [xCursor + width, zCursor], [xCursor + width, zCursor + depth], [xCursor, zCursor + depth]]
    })
    railSegments.push({ id: `rail-bay-${row}-${col}`, kind: 'bay-port', from: [x, 7.5, z - Math.min(depth / 2 - 1, 10)], to: [x, 7.5, z + Math.min(depth / 2 - 1, 10)] })
    xCursor += width + aisle
  }
  if (row < rowDepths.length - 1) {
    const corridorZ = zCursor + depth + aisle / 2
    zones.push({ id: `zone-corridor-${row}`, kind: 'corridor', polygon: [[-totalWidth / 2, corridorZ - aisle / 2], [totalWidth / 2, corridorZ - aisle / 2], [totalWidth / 2, corridorZ + aisle / 2], [-totalWidth / 2, corridorZ + aisle / 2]] })
    railSegments.push({ id: `rail-trunk-${row}`, kind: 'trunk', from: [-totalWidth / 2 + 1, 7.5, corridorZ], to: [totalWidth / 2 - 1, 7.5, corridorZ] })
  }
  zCursor += depth + aisle
}
for (let col = 0; col < columnCenters.length; col++) railSegments.push({ id: `rail-spine-${col}`, kind: 'spine', from: [columnCenters[col], 7.5, -totalDepth / 2 + 1], to: [columnCenters[col], 7.5, totalDepth / 2 - 1] })

const layout = {
  version: '1.0', name: 'fab-default',
  fab: { width: 220, depth: 240, wallHeight: 4.8, ceilingHeight: 9 },
  grid: { rows: 6, cols: 12, columnWidths, rowDepths, aisleWidth: aisle },
  bays,
  stockers: [
    { id: 'stk-west', position: [-totalWidth / 2 - 12, 0, 0], capacity: 48 },
    { id: 'stk-east', position: [totalWidth / 2 + 12, 0, 0], capacity: 48 }
  ],
  ohtRail: { height: 7.5, segments: railSegments }, zones,
  emergency: {
    exits: [
      { id: 'exit-north', position: [0, 0, -totalDepth / 2 - 5], heading: Math.PI },
      { id: 'exit-south', position: [0, 0, totalDepth / 2 + 5], heading: 0 },
      { id: 'exit-west', position: [-totalWidth / 2 - 5, 0, 0], heading: -Math.PI / 2 },
      { id: 'exit-east', position: [totalWidth / 2 + 5, 0, 0], heading: Math.PI / 2 }
    ],
    musterPoints: [
      { id: 'muster-north', position: [0, 0, -totalDepth / 2 - 18], capacity: 100 },
      { id: 'muster-south', position: [0, 0, totalDepth / 2 + 18], capacity: 100 }
    ],
    medicalStation: { position: [-totalWidth / 2 - 12, 0, -totalDepth / 2 - 12] },
    fireAccessRoutes: [{ id: 'fire-main', nodes: [[-totalWidth / 2 - 15, 0], [0, 0], [totalWidth / 2 + 15, 0]] }],
    safetyDevices: [
      { id: 'gas-valve-west', kind: 'gas-isolation-valve', position: [-totalWidth / 2 + 5, 1.05, rowCenters[0] + rowDepths[0] / 2 + aisle / 2], heading: 0, servesZone: 'zone-bay-0-0' },
      { id: 'gas-valve-central', kind: 'gas-isolation-valve', position: [columnCenters[5], 1.05, rowCenters[2] + rowDepths[2] / 2 + aisle / 2], heading: Math.PI, servesZone: 'zone-bay-2-5' },
      { id: 'fire-panel-east', kind: 'fire-panel', position: [totalWidth / 2 - 5, 1.15, rowCenters[4] + rowDepths[4] / 2 + aisle / 2], heading: Math.PI, servesZone: 'zone-bay-4-11' }
    ]
  },
  population: {
    oht: 160,
    agv: 160,
    igv: 8,
    humanoid: 2,
    humanoidStations: [
      [-totalWidth / 2, 0, -totalDepth / 2],
      [-totalWidth / 2, 0, rowCenters[0] + rowDepths[0] / 2]
    ],
    responderStations: [
      [-totalWidth / 2 + 14, 0, rowCenters[0] + rowDepths[0] / 2 + aisle / 2],
      [-totalWidth / 2 + 38, 0, rowCenters[0] + rowDepths[0] / 2 + aisle / 2],
      [-20, 0, rowCenters[2] + rowDepths[2] / 2 + aisle / 2],
      [20, 0, rowCenters[2] + rowDepths[2] / 2 + aisle / 2],
      [totalWidth / 2 - 38, 0, rowCenters[4] + rowDepths[4] / 2 + aisle / 2],
      [totalWidth / 2 - 14, 0, rowCenters[4] + rowDepths[4] / 2 + aisle / 2]
    ],
    arm: 18,
    people: [{ role: 'engineer', count: 60 }, { role: 'operator', count: 34 }, { role: 'responder', count: 6 }]
  }
}

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(layout, null, 2)}\n`)
console.log(`Created ${output} with ${bays.length} bays and ${railSegments.length} rail segments.`)
