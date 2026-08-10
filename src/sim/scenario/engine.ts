import type { Scenario, ScenarioAction, ScenarioTrigger } from '../../core/schema'
import type { SimWorld } from '../world'

export class ScenarioEngine {
  private scenario?: Scenario
  private fired = new Set<number>()
  private startedAt = 0
  load(scenario: Scenario, simTime: number): void { this.scenario = scenario; this.fired.clear(); this.startedAt = simTime }
  clear(): void { this.scenario = undefined; this.fired.clear(); this.startedAt = 0 }
  update(world: SimWorld): void {
    if (!this.scenario) return
    this.scenario.steps.forEach((step, index) => {
      if (!this.fired.has(index) && this.matches(step.trigger, world)) {
        this.fired.add(index); for (const action of step.actions) this.execute(action, world)
      }
    })
  }
  private matches(trigger: ScenarioTrigger, world: SimWorld): boolean {
    switch (trigger.type) {
      case 'time': return world.simTime - this.startedAt >= trigger.delay
      case 'phase': return world.emergency.phase === trigger.phase
      case 'entityAt': return world.entities.some((entity) => world.matchesSelector(entity, trigger.selector) && world.layout.zoneAt(entity.x, entity.z) === trigger.zone)
      case 'entityState': return world.entities.some((entity) => world.matchesSelector(entity, trigger.selector) && entity.status === trigger.state)
      case 'populationAt': {
        const people = world.entities.filter((entity) => entity.kind === 'person' && entity.role !== 'responder')
        const muster = world.layout.layout.emergency.musterPoints
        const arrived = people.filter((entity) => muster.some((point) => Math.hypot(entity.x - point.position[0], entity.z - point.position[2]) < 5)).length
        return people.length > 0 && arrived / people.length >= trigger.ratio
      }
      case 'all': return trigger.conditions.every((condition) => this.matches(condition, world))
      case 'any': return trigger.conditions.some((condition) => this.matches(condition, world))
    }
  }
  private execute(action: ScenarioAction, world: SimWorld): void {
    switch (action.type) {
      case 'setPhase': world.setPhase(action.phase); break
      case 'spawnHazard': world.triggerEmergency(action.kind); break
      case 'overrideBehavior': world.overrideBehavior(action.selector, action.behavior); break
      case 'dispatchResponder': world.dispatchResponders(action.count); break
      case 'dispatchVehicle': world.dispatchVehicle(action.vehicleType, action.mission); break
      case 'hudMessage': world.events.push({ type: 'hudMessage', message: action.text, data: { severity: action.severity } }); break
      case 'cameraCue': world.events.push({ type: 'log', message: `카메라 큐: ${action.shot}` }); break
      case 'wait': break
      case 'endScenario': world.finishEmergency(); break
    }
  }
}
