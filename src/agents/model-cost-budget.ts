export const modelCostBudgetDecisionSchemaVersion = "model-cost-budget-decision/v2" as const;

export type ModelAgentStage = "test" | "build";

export interface ModelStageCostBudget {
  readonly limitUsd: number;
  readonly reservationUsd: number;
}

export interface ModelCostBudgets {
  readonly dailyLimitUsd: number;
  readonly stages: Readonly<Record<ModelAgentStage, ModelStageCostBudget>>;
}

export interface ModelCostReservationRequest {
  readonly scope: string;
  readonly stage: ModelAgentStage;
  readonly stageLimitUsd: number;
  readonly dailyLimitUsd: number;
  readonly specificationLimitUsd: number;
  readonly reservationUsd: number;
}

export interface ModelCostReservation {
  readonly id: number;
  readonly request: ModelCostReservationRequest;
  readonly dailyCommittedBeforeUsd: number;
  readonly specificationCommittedBeforeUsd: number;
}

export interface ModelCostBudgetDecision {
  readonly schemaVersion: typeof modelCostBudgetDecisionSchemaVersion;
  readonly status: "approved";
  readonly accounting: "validated-usage" | "conservative-reservation";
  readonly stage: ModelAgentStage;
  readonly stageLimitUsd: number;
  readonly dailyLimitUsd: number;
  readonly specificationLimitUsd: number;
  readonly reservedCostUsd: number;
  readonly actualCostUsd: number;
  readonly dailyCommittedBeforeUsd: number;
  readonly dailyCommittedAfterUsd: number;
  readonly specificationCommittedBeforeUsd: number;
  readonly specificationCommittedAfterUsd: number;
}

export interface ModelCostBudgetState {
  reserve(request: ModelCostReservationRequest): ModelCostReservation;
  settle(reservation: ModelCostReservation, actualCostUsd: number): ModelCostBudgetDecision;
  consumeReservation(reservation: ModelCostReservation): ModelCostBudgetDecision;
}

export class ModelCostBudgetError extends Error {
  override readonly name = "ModelCostBudgetError";
}

interface ActiveReservation {
  readonly reservation: ModelCostReservation;
  readonly reservationMicros: number;
}

export class InMemoryModelCostBudgetState implements ModelCostBudgetState {
  private nextId = 1;
  private dailyCommittedMicros = 0;
  private readonly specificationCommittedMicros = new Map<string, number>();
  private readonly active = new Map<number, ActiveReservation>();

  reserve(request: ModelCostReservationRequest): ModelCostReservation {
    const reservationMicros = costMicros(request.reservationUsd, "reserved model cost");
    const stageLimitMicros = costMicros(request.stageLimitUsd, `${request.stage} stage cost limit`);
    const dailyLimitMicros = costMicros(request.dailyLimitUsd, "daily model cost limit");
    const specificationLimitMicros = costMicros(request.specificationLimitUsd, "specification cost limit");
    if (reservationMicros === 0) throw new ModelCostBudgetError(`${request.stage} stage reserved model cost must be greater than zero.`);
    if (reservationMicros > stageLimitMicros) {
      throw new ModelCostBudgetError(`${request.stage} stage reserved model cost exceeds its stage limit.`);
    }
    const specificationCommittedMicros = this.specificationCommittedMicros.get(request.scope) ?? 0;
    if (this.dailyCommittedMicros + reservationMicros > dailyLimitMicros) {
      throw new ModelCostBudgetError(`${request.stage} stage reserved model cost is unavailable within the remaining daily budget.`);
    }
    if (specificationCommittedMicros + reservationMicros > specificationLimitMicros) {
      throw new ModelCostBudgetError(`${request.stage} stage reserved model cost is unavailable within the remaining specification budget.`);
    }
    const reservation: ModelCostReservation = {
      id: this.nextId++,
      request,
      dailyCommittedBeforeUsd: usd(this.dailyCommittedMicros),
      specificationCommittedBeforeUsd: usd(specificationCommittedMicros),
    };
    this.dailyCommittedMicros += reservationMicros;
    this.specificationCommittedMicros.set(request.scope, specificationCommittedMicros + reservationMicros);
    this.active.set(reservation.id, { reservation, reservationMicros });
    return reservation;
  }

  settle(reservation: ModelCostReservation, actualCostUsd: number): ModelCostBudgetDecision {
    const actualMicros = costMicros(actualCostUsd, "actual model cost");
    const active = this.take(reservation);
    if (actualMicros > active.reservationMicros) {
      throw new ModelCostBudgetError(`${reservation.request.stage} stage actual model cost exceeds its reserved budget.`);
    }
    this.replaceReservation(active, actualMicros);
    const specificationCommittedMicros = this.specificationCommittedMicros.get(reservation.request.scope) ?? 0;
    const decision: ModelCostBudgetDecision = {
      schemaVersion: modelCostBudgetDecisionSchemaVersion,
      status: "approved",
      accounting: "validated-usage",
      stage: reservation.request.stage,
      stageLimitUsd: reservation.request.stageLimitUsd,
      dailyLimitUsd: reservation.request.dailyLimitUsd,
      specificationLimitUsd: reservation.request.specificationLimitUsd,
      reservedCostUsd: reservation.request.reservationUsd,
      actualCostUsd,
      dailyCommittedBeforeUsd: reservation.dailyCommittedBeforeUsd,
      dailyCommittedAfterUsd: usd(this.dailyCommittedMicros),
      specificationCommittedBeforeUsd: reservation.specificationCommittedBeforeUsd,
      specificationCommittedAfterUsd: usd(specificationCommittedMicros),
    };
    return decision;
  }

  consumeReservation(reservation: ModelCostReservation): ModelCostBudgetDecision {
    const active = this.take(reservation);
    const specificationCommittedMicros = this.specificationCommittedMicros.get(reservation.request.scope) ?? 0;
    return {
      schemaVersion: modelCostBudgetDecisionSchemaVersion,
      status: "approved",
      accounting: "conservative-reservation",
      stage: reservation.request.stage,
      stageLimitUsd: reservation.request.stageLimitUsd,
      dailyLimitUsd: reservation.request.dailyLimitUsd,
      specificationLimitUsd: reservation.request.specificationLimitUsd,
      reservedCostUsd: reservation.request.reservationUsd,
      actualCostUsd: usd(active.reservationMicros),
      dailyCommittedBeforeUsd: reservation.dailyCommittedBeforeUsd,
      dailyCommittedAfterUsd: usd(this.dailyCommittedMicros),
      specificationCommittedBeforeUsd: reservation.specificationCommittedBeforeUsd,
      specificationCommittedAfterUsd: usd(specificationCommittedMicros),
    };
  }

  private take(reservation: ModelCostReservation): ActiveReservation {
    const active = this.active.get(reservation.id);
    if (!active || active.reservation !== reservation) throw new ModelCostBudgetError("Model cost reservation is unavailable or already settled.");
    this.active.delete(reservation.id);
    return active;
  }

  private replaceReservation(active: ActiveReservation, actualMicros: number): void {
    const { reservation, reservationMicros } = active;
    this.dailyCommittedMicros += actualMicros - reservationMicros;
    const specificationCommittedMicros = this.specificationCommittedMicros.get(reservation.request.scope) ?? 0;
    this.specificationCommittedMicros.set(
      reservation.request.scope,
      specificationCommittedMicros + actualMicros - reservationMicros,
    );
  }
}

export function validateModelCostBudgets(budgets: ModelCostBudgets): ModelCostBudgets {
  costMicros(budgets.dailyLimitUsd, "daily model cost limit");
  for (const stage of ["test", "build"] as const) {
    costMicros(budgets.stages[stage].limitUsd, `${stage} stage cost limit`);
    costMicros(budgets.stages[stage].reservationUsd, `${stage} stage reserved model cost`);
  }
  return budgets;
}

function costMicros(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 10_000) {
    throw new ModelCostBudgetError(`${name} must be a finite number from 0 through 10000.`);
  }
  const micros = Math.round(value * 1_000_000);
  if (Math.abs(micros / 1_000_000 - value) > Number.EPSILON * Math.max(1, value)) {
    throw new ModelCostBudgetError(`${name} must use at most six decimal places.`);
  }
  return micros;
}

function usd(micros: number): number {
  return micros / 1_000_000;
}
