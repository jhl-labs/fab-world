import { readFileSync } from 'node:fs'
import { FabLayoutSchema, type EmergencyKind } from '../src/core/schema'
import { FIXED_DT, SIM_HZ } from '../src/sim/clock'
import { SimWorld } from '../src/sim/world'

const layout = FabLayoutSchema.parse(JSON.parse(readFileSync(new URL('../data/layouts/fab-default.json', import.meta.url), 'utf8')))
const cases: Array<{ kind: Extract<EmergencyKind, 'fire' | 'gasLeak'>; seed: number }> = [
  { kind: 'fire', seed: 77 },
  { kind: 'gasLeak', seed: 42 }
]

const results = cases.map(({ kind, seed }) => {
  const world = new SimWorld(layout, seed)
  const people = world.entities.filter((entity) => entity.kind === 'person' && entity.role !== 'responder')
  const humanoids = world.entities.filter((entity) => entity.kind === 'humanoid')
  const previous = new Map(people.map((person) => [person.id, {
    speed: person.speed,
    yaw: person.yaw,
    behavior: person.behavior,
    activity: person.personActivity
  }]))
  let minimumDistance = Infinity
  let overlapSamples = 0
  let maximumAcceleration = 0
  let maximumTurnRate = 0
  let minimumHumanRobotDistance = Infinity
  let closestHumanRobot: {
    at: number
    person: string
    personActivity: string
    personSpeed: number
    robot: string
    robotActivity: string
    robotSpeed: number
  } | undefined
  let settledMinimumSpacing: number | undefined
  let settledMaximumRadius: number | undefined
  let settledMaximumHeadingError: number | undefined
  let evacuatedAt: number | undefined
  let assembledAt: number | undefined
  let reactionDelays: Array<{ role: string; delay: number }> | undefined
  const departures = new Map<string, number>()

  world.triggerEmergency(kind)
  for (let tick = 0; tick < 300 * SIM_HZ; tick++) {
    world.tick(FIXED_DT)
    if (!reactionDelays && world.emergency.phase === 'alarm') {
      reactionDelays = people.map((person) => ({
        role: person.role ?? 'unknown',
        delay: (person.reactionUntil ?? world.simTime) - (person.reactionStartedAt ?? world.simTime)
      }))
    }
    for (const person of people) {
      const old = previous.get(person.id)!
      const stableBehavior = old.behavior === person.behavior && old.activity === person.personActivity
      if (stableBehavior && person.personActivity !== 'reacting' && person.personActivity !== 'collapsed') {
        maximumAcceleration = Math.max(maximumAcceleration, Math.abs(person.speed - old.speed) / FIXED_DT)
        if (old.speed > 0.2 && person.speed > 0.2) {
          const yawDelta = Math.atan2(Math.sin(person.yaw - old.yaw), Math.cos(person.yaw - old.yaw))
          maximumTurnRate = Math.max(maximumTurnRate, Math.abs(yawDelta) / FIXED_DT)
        }
      }
      previous.set(person.id, {
        speed: person.speed,
        yaw: person.yaw,
        behavior: person.behavior,
        activity: person.personActivity
      })
      if (!departures.has(person.id) && person.personActivity === 'evacuating' && person.speed > 0.05) {
        departures.set(person.id, world.simTime - world.emergency.startedAt)
      }
    }
    if (tick % 6 === 0) {
      for (let left = 0; left < people.length; left++) for (let right = left + 1; right < people.length; right++) {
        const distance = Math.hypot(people[left]!.x - people[right]!.x, people[left]!.z - people[right]!.z)
        minimumDistance = Math.min(minimumDistance, distance)
        if (distance < 0.28) overlapSamples++
      }
      for (const person of people) for (const robot of humanoids) {
        const distance = Math.hypot(person.x - robot.x, person.z - robot.z)
        if (distance < minimumHumanRobotDistance) {
          minimumHumanRobotDistance = distance
          closestHumanRobot = {
            at: world.simTime,
            person: person.id,
            personActivity: person.personActivity ?? 'none',
            personSpeed: person.speed,
            robot: robot.id,
            robotActivity: robot.activity ?? 'none',
            robotSpeed: robot.speed
          }
        }
      }
    }
    if (evacuatedAt === undefined && world.metrics.evacuated === world.metrics.totalEvacuees) {
      evacuatedAt = world.simTime
    }
    if (assembledAt === undefined && world.assemblyComplete()) {
      assembledAt = world.simTime
      settledMinimumSpacing = pairMinimum(people.map((person) => [person.x, person.z]))
      settledMaximumRadius = Math.max(...people.map((person) => {
        const muster = layout.emergency.musterPoints.find((point) => point.id === person.evacuationMusterId)!
        return Math.hypot(person.goalX - muster.position[0], person.goalZ - muster.position[2])
      }))
      settledMaximumHeadingError = Math.max(...people.map((person) => {
        const checkInYaw = world.musterCheckInYaw(person)!
        return Math.abs(Math.atan2(Math.sin(person.yaw - checkInYaw), Math.cos(person.yaw - checkInYaw)))
      }))
    }
    if (world.emergency.phase === 'normal' && tick > SIM_HZ) break
  }

  if (evacuatedAt === undefined) throw new Error(`${kind}: evacuation did not complete`)
  if (assembledAt === undefined) throw new Error(`${kind}: muster formation did not complete`)
  if (overlapSamples > 0 || minimumDistance < 0.28) throw new Error(`${kind}: physical overlap ${minimumDistance.toFixed(3)}m`)
  if ((settledMinimumSpacing ?? 0) < 0.6) throw new Error(`${kind}: assembled crowd spacing is too tight (${settledMinimumSpacing?.toFixed(3)}m)`)
  if ((settledMaximumRadius ?? Infinity) > 4.5) throw new Error(`${kind}: muster slot exceeds the 4.5m assembly radius`)
  if (maximumAcceleration > 3.2) throw new Error(`${kind}: pedestrian acceleration spike ${maximumAcceleration.toFixed(3)}m/s²`)
  if (maximumTurnRate > 5.5) throw new Error(`${kind}: pedestrian turn-rate spike ${maximumTurnRate.toFixed(3)}rad/s`)
  if (minimumHumanRobotDistance < 0.67) throw new Error(`${kind}: human/robot body envelope violated at ${minimumHumanRobotDistance.toFixed(3)}m`)
  if (!reactionDelays || reactionDelays.length !== people.length) throw new Error(`${kind}: alarm reaction profile was not captured`)
  if (departures.size !== people.length) throw new Error(`${kind}: ${people.length - departures.size} evacuees never visibly departed`)
  const operatorDelays = reactionDelays.filter(({ role }) => role === 'operator').map(({ delay }) => delay)
  const engineerDelays = reactionDelays.filter(({ role }) => role === 'engineer').map(({ delay }) => delay)
  const allDepartures = [...departures.values()]
  const departureBins = new Map<number, number>()
  for (const departure of allDepartures) {
    const bin = Math.floor(departure / 0.25)
    departureBins.set(bin, (departureBins.get(bin) ?? 0) + 1)
  }
  const maximumQuarterSecondDepartures = Math.max(...departureBins.values())
  if (uniqueRatio(reactionDelays.map(({ delay }) => delay)) < 0.8) throw new Error(`${kind}: alarm reactions remain visibly synchronized`)
  if (Math.max(...allDepartures) - Math.min(...allDepartures) < 1.5) throw new Error(`${kind}: crowd departure window is too synchronized`)
  if (maximumQuarterSecondDepartures / people.length > 0.25) throw new Error(`${kind}: too many evacuees depart in one 250ms window`)
  if ((settledMaximumHeadingError ?? Infinity) >= 0.08) throw new Error(`${kind}: mustered people do not face the check-in exit`)

  return {
    kind,
    seed,
    evacuatedAt: Number(evacuatedAt.toFixed(3)),
    assembledAt: Number(assembledAt.toFixed(3)),
    minimumDistance: Number(minimumDistance.toFixed(3)),
    overlapSamples,
    settledMinimumSpacing: Number(settledMinimumSpacing!.toFixed(3)),
    settledMaximumRadius: Number(settledMaximumRadius!.toFixed(3)),
    settledMaximumHeadingError: Number(settledMaximumHeadingError!.toFixed(3)),
    minimumHumanRobotDistance: Number(minimumHumanRobotDistance.toFixed(3)),
    closestHumanRobot: closestHumanRobot && {
      ...closestHumanRobot,
      at: Number(closestHumanRobot.at.toFixed(3)),
      personSpeed: Number(closestHumanRobot.personSpeed.toFixed(3)),
      robotSpeed: Number(closestHumanRobot.robotSpeed.toFixed(3))
    },
    operatorReactionRange: range(operatorDelays),
    engineerReactionRange: range(engineerDelays),
    evacuationSpeedRange: range(people.map((person) => person.emergencySpeed!)),
    departureWindow: Number((Math.max(...allDepartures) - Math.min(...allDepartures)).toFixed(3)),
    maximumQuarterSecondDepartures,
    maximumAcceleration: Number(maximumAcceleration.toFixed(3)),
    maximumTurnRate: Number(maximumTurnRate.toFixed(3))
  }
})

console.log(JSON.stringify(results, null, 2))

function pairMinimum(points: Array<readonly [number, number]>): number {
  let minimum = Infinity
  for (let left = 0; left < points.length; left++) for (let right = left + 1; right < points.length; right++) {
    minimum = Math.min(minimum, Math.hypot(points[left]![0] - points[right]![0], points[left]![1] - points[right]![1]))
  }
  return minimum
}

function range(values: number[]): readonly [number, number] {
  return [
    Number(Math.min(...values).toFixed(3)),
    Number(Math.max(...values).toFixed(3))
  ]
}

function uniqueRatio(values: number[]): number {
  return new Set(values.map((value) => value.toFixed(4))).size / Math.max(1, values.length)
}
